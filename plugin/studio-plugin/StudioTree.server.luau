--!strict
-- Sends this place's instance tree to the roblox-studio-link listener on this machine,
-- so Claude can search it on disk instead of walking Studio through MCP.
--
-- Rows (version 2): path, ClassName, childCount, depth, nameLength, tags, attributes, text, lines.
-- Adds and removes under a service re-send only the top-level instance they happened in (a delta);
-- hand edits (renames, moves, undo) and the toolbar button re-send everything.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local PORT = 34950
local QUIET_SECONDS = 3
local RETRY_SECONDS = 15
local FULL_RESYNC_SECONDS = 300
local HEARTBEAT_SECONDS = 30
local MAX_DELTA_ROOTS = 30
local FORMAT = "# studio-tree 2"
local ROOT_SEPARATOR = "\u{1F}"
local BATCH = 1000
local TEXT_LIMIT = 60

local SERVICES = {
	"Workspace",
	"Lighting",
	"MaterialService",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"ServerScriptService",
	"ServerStorage",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"SoundService",
	"Teams",
	"TextChatService",
}

local TEXT_CLASSES: { [string]: boolean } = { TextLabel = true, TextButton = true, TextBox = true }
local SCRIPT_CLASSES: { [string]: boolean } = { Script = true, LocalScript = true, ModuleScript = true }

-- Plugins load into play-mode DataModels too; only the edit DataModel is the place.
if RunService:IsRunning() then
	return
end

local dirtyAt: number? = 0
local isFullDirty = true
local dirtyRoots: { [string]: boolean } = {}
local lastFullAt = 0
local retryAt = 0
local isSending = false
local hasWarned = false

local function clean(text: string): string
	return (text:gsub("[\t\r\n]", " "))
end

local function placeKey(): string
	if game.PlaceId ~= 0 then
		return tostring(game.PlaceId)
	end
	local name = game.Name:gsub("[^%w_-]", "_"):sub(1, 60)
	return "local-" .. name
end

-- One id per Studio process, so two Studios on the same place keep separate snapshots.
local session = HttpService:GenerateGUID(false):gsub("[^%x]", ""):sub(1, 8):lower()

local function snapshotUrl(path: string): string
	return `http://127.0.0.1:{PORT}{path}?place={placeKey()}&session={session}`
end

local function getService(name: string): Instance?
	local ok, service = pcall(game.FindService, game, name)
	if ok and service then
		return service
	end
	return nil
end

-- Cut at a character boundary: a split multi-byte character is invalid UTF-8 and the listener rejects it.
local function truncate(text: string): string
	if utf8.len(text) == nil then
		return ""
	end
	local cut = utf8.offset(text, TEXT_LIMIT + 1)
	if cut == nil then
		return text
	end
	return text:sub(1, cut - 1)
end

local function describe(child: Instance, kids: number, path: string, depth: number, nameLength: number): string
	local tags = child:GetTags()
	local attributes = ""
	local names = {}
	for name in child:GetAttributes() do
		names[#names + 1] = name
	end
	if #names > 0 then
		table.sort(names)
		attributes = table.concat(names, ",")
	end

	local text = ""
	if TEXT_CLASSES[child.ClassName] then
		local ok, value = pcall(function()
			return (child :: any).Text
		end)
		if ok and type(value) == "string" then
			text = clean(truncate(value))
		end
	end

	local lines = ""
	if SCRIPT_CLASSES[child.ClassName] then
		local ok, source = pcall(function()
			return (child :: any).Source
		end)
		if ok and type(source) == "string" then
			local _, breaks = source:gsub("\n", "")
			lines = tostring(breaks + 1)
		end
	end

	return `{path}\t{child.ClassName}\t{kids}\t{depth}\t{nameLength}\t{table.concat(tags, ",")}\t{attributes}\t{text}\t{lines}`
end

-- Appends one row per instance under `children`, yielding every BATCH rows so Studio does not hitch.
local function walk(lines: { string }, children: { Instance }, path: string, depth: number)
	for _, child in children do
		local name = clean(child.Name)
		local childPath = `{path}.{name}`
		local grandchildren = child:GetChildren()
		lines[#lines + 1] = describe(child, #grandchildren, childPath, depth, #name)
		if #lines % BATCH == 0 then
			task.wait()
		end
		walk(lines, grandchildren, childPath, depth + 1)
	end
end

local function walkService(lines: { string }, service: Instance)
	local children = service:GetChildren()
	lines[#lines + 1] = describe(service, #children, service.Name, 1, #service.Name)
	walk(lines, children, service.Name, 2)
end

local function header(count: number, extra: string): string
	return `{FORMAT}\tplace={placeKey()}\tname={clean(game.Name)}\tat={os.time()}\tcount={count}{extra}`
end

local function fullSnapshot(): string
	local lines: { string } = {}
	for _, name in SERVICES do
		local service = getService(name)
		if service then
			walkService(lines, service)
		end
	end
	return header(#lines, "") .. "\n" .. table.concat(lines, "\n") .. "\n"
end

-- `roots` are "Service.Child" paths. A root that no longer exists sends no rows, which deletes it.
local function deltaSnapshot(roots: { string }): string
	local lines: { string } = {}
	for _, root in roots do
		local serviceName, childName = root:match("^([^.]+)%.(.+)$")
		local service = if serviceName then getService(serviceName) else nil
		if service and childName then
			for _, child in service:GetChildren() do
				if clean(child.Name) == childName then
					local grandchildren = child:GetChildren()
					lines[#lines + 1] = describe(child, #grandchildren, root, 2, #childName)
					walk(lines, grandchildren, root, 3)
				end
			end
		end
	end
	local extra = `\tmode=delta\troots={table.concat(roots, ROOT_SEPARATOR)}`
	return header(#lines, extra) .. "\n" .. table.concat(lines, "\n") .. (if #lines > 0 then "\n" else "")
end

local function post(body: string): (boolean, number, string)
	local ok, response = pcall(HttpService.RequestAsync, HttpService, {
		Url = snapshotUrl("/tree"),
		Method = "POST",
		Headers = { ["Content-Type"] = "text/plain", ["X-Studio-Tree"] = "1" },
		Body = body,
		Compress = Enum.HttpCompression.Gzip,
	})
	if ok then
		return response.Success, response.StatusCode, response.Body
	end
	return false, 0, tostring(response)
end

local function send()
	isSending = true
	local startedAt = dirtyAt
	local wasFull = isFullDirty
	local roots = dirtyRoots
	isFullDirty = false
	dirtyRoots = {}

	local rootList = {}
	for root in roots do
		rootList[#rootList + 1] = root
	end
	table.sort(rootList)

	local isFull = wasFull
		or #rootList == 0
		or #rootList > MAX_DELTA_ROOTS
		or os.clock() - lastFullAt > FULL_RESYNC_SECONDS
	local built, body = pcall(if isFull then fullSnapshot else deltaSnapshot, rootList)
	local ok, status, answer = false, 0, ""
	if built then
		ok, status, answer = post(body :: string)
	else
		warn(`Studio Tree: could not read the tree: {body}`)
	end
	isSending = false

	if ok then
		if isFull then
			lastFullAt = os.clock()
		end
		if dirtyAt == startedAt then
			dirtyAt = nil
		end
		hasWarned = false
		return
	end

	-- Put the work back: the next try sends what this one tried to, plus whatever changed meanwhile.
	if isFull then
		isFullDirty = true
	else
		for _, root in rootList do
			dirtyRoots[root] = true
		end
	end
	if status == 409 then
		-- The listener has no snapshot to patch: send everything straight away.
		isFullDirty = true
		retryAt = 0
		return
	end
	retryAt = os.clock() + RETRY_SECONDS
	if not hasWarned then
		hasWarned = true
		local reason = if status == 0 then "no answer" else `HTTP {status}: {answer}`
		warn(
			`Studio Tree: no listener on 127.0.0.1:{PORT} ({reason}). Open Claude Code with roblox-studio-link to start it; retrying every {RETRY_SECONDS} s.`
		)
	end
end

-- The top-level instance of `service` that holds (or is) `descendant`.
local function markDirtyUnder(service: Instance, descendant: Instance)
	local top: Instance = descendant
	while top.Parent ~= nil and top.Parent ~= service do
		top = top.Parent :: Instance
	end
	if top.Parent == service then
		dirtyRoots[`{service.Name}.{clean(top.Name)}`] = true
	else
		isFullDirty = true
	end
	dirtyAt = os.clock()
end

local function markFullDirty()
	isFullDirty = true
	dirtyAt = os.clock()
end

for _, name in SERVICES do
	local service = getService(name)
	if service then
		service.DescendantAdded:Connect(function(descendant)
			markDirtyUnder(service, descendant)
		end)
		-- On removal the parent is still set, so the walk up finds the same root.
		service.DescendantRemoving:Connect(function(descendant)
			markDirtyUnder(service, descendant)
		end)
		-- A service's own direct children arrive as descendants too; nothing else to hook.
	end
end

-- Hand edits (renames, moves, property changes) end in a recording; adds and removes are caught above.
for _, signalName in { "OnRecordingFinished", "OnUndo", "OnRedo" } do
	local ok, signal = pcall(function()
		return (ChangeHistoryService :: any)[signalName]
	end)
	if ok and typeof(signal) == "RBXScriptSignal" then
		signal:Connect(markFullDirty)
	end
end

-- A heartbeat tells the listener this Studio is still open. A 404 means it lost the snapshot (a restart): send it again.
local function heartbeat()
	local ok, response = pcall(HttpService.RequestAsync, HttpService, {
		Url = snapshotUrl("/ping"),
		Method = "PUT",
		Headers = { ["X-Studio-Tree"] = "1" },
	})
	if ok and response.StatusCode == 404 then
		markFullDirty()
	end
end

plugin.Unloading:Connect(function()
	pcall(HttpService.RequestAsync, HttpService, {
		Url = snapshotUrl("/tree"),
		Method = "DELETE",
		Headers = { ["X-Studio-Tree"] = "1" },
	})
end)

local toolbar = plugin:CreateToolbar("Studio Tree")
local button = toolbar:CreateButton("Send tree", "Send this place's instance tree to Claude now", "")
button.ClickableWhenViewportHidden = true
button.Click:Connect(function()
	button:SetActive(false)
	retryAt = 0
	hasWarned = false
	isFullDirty = true
	dirtyAt = 0
end)

task.spawn(function()
	local nextHeartbeat = os.clock() + HEARTBEAT_SECONDS
	while true do
		task.wait(1)
		local now = os.clock()
		if dirtyAt and not isSending and now - dirtyAt >= QUIET_SECONDS and now >= retryAt then
			send()
		elseif not isSending and now >= nextHeartbeat then
			nextHeartbeat = now + HEARTBEAT_SECONDS
			heartbeat()
		end
	end
end)
