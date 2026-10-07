--!strict
-- Sends this place's instance tree to the roblox-studio-link listener on this machine,
-- so Claude can search it on disk instead of walking Studio through MCP.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local PORT = 34950
local QUIET_SECONDS = 3
local RETRY_SECONDS = 15
local FORMAT = "# studio-tree 1"
local BATCH = 1000

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

-- Plugins load into play-mode DataModels too; only the edit DataModel is the place.
if RunService:IsRunning() then
	return
end

local dirtyAt: number? = 0
local retryAt = 0
local isSending = false
local hasWarned = false

local function markDirty()
	dirtyAt = os.clock()
end

local function placeKey(): string
	if game.PlaceId ~= 0 then
		return tostring(game.PlaceId)
	end
	local name = game.Name:gsub("[^%w_-]", "_"):sub(1, 60)
	return "local-" .. name
end

local function clean(text: string): string
	return (text:gsub("[\t\r\n]", " "))
end

local function snapshot(): string
	local lines = table.create(4096)
	local count = 0

	local function walk(children: { Instance }, path: string)
		for _, child in children do
			local childPath = `{path}.{clean(child.Name)}`
			local grandchildren = child:GetChildren()
			count += 1
			lines[count + 1] = `{childPath}\t{child.ClassName}\t{#grandchildren}`
			-- A large place takes most of a second to walk; yielding keeps Studio from hitching.
			if count % BATCH == 0 then
				task.wait()
			end
			walk(grandchildren, childPath)
		end
	end

	for _, name in SERVICES do
		local ok, service = pcall(game.FindService, game, name)
		if ok and service then
			local children = service:GetChildren()
			count += 1
			lines[count + 1] = `{name}\t{service.ClassName}\t{#children}`
			walk(children, name)
		end
	end

	lines[1] = `{FORMAT}\tplace={placeKey()}\tname={clean(game.Name)}\tat={os.time()}\tcount={count}`
	return table.concat(lines, "\n", 1, count + 1) .. "\n"
end

local function send()
	isSending = true
	local startedAt = dirtyAt
	local ok, response = pcall(HttpService.RequestAsync, HttpService, {
		Url = `http://127.0.0.1:{PORT}/tree?place={placeKey()}`,
		Method = "POST",
		Headers = { ["Content-Type"] = "text/plain", ["X-Studio-Tree"] = "1" },
		Body = snapshot(),
		Compress = Enum.HttpCompression.Gzip,
	})
	isSending = false

	if ok and response.Success then
		if dirtyAt == startedAt then
			dirtyAt = nil
		end
		hasWarned = false
		return
	end

	retryAt = os.clock() + RETRY_SECONDS
	if not hasWarned then
		hasWarned = true
		local reason = if ok then `HTTP {response.StatusCode}` else tostring(response)
		warn(`Studio Tree: no listener on 127.0.0.1:{PORT} ({reason}). Open Claude Code with roblox-studio-link to start it; retrying every {RETRY_SECONDS} s.`)
	end
end

for _, name in SERVICES do
	local ok, service = pcall(game.FindService, game, name)
	if ok and service then
		service.DescendantAdded:Connect(markDirty)
		service.DescendantRemoving:Connect(markDirty)
	end
end

-- Hand edits (renames, moves, property changes) end in a recording; Rojo's adds and removes are caught above.
for _, signalName in { "OnRecordingFinished", "OnUndo", "OnRedo" } do
	local ok, signal = pcall(function()
		return (ChangeHistoryService :: any)[signalName]
	end)
	if ok and typeof(signal) == "RBXScriptSignal" then
		signal:Connect(markDirty)
	end
end

local toolbar = plugin:CreateToolbar("Studio Tree")
local button = toolbar:CreateButton("Send tree", "Send this place's instance tree to Claude now", "")
button.ClickableWhenViewportHidden = true
button.Click:Connect(function()
	button:SetActive(false)
	retryAt = 0
	hasWarned = false
	dirtyAt = 0
end)

task.spawn(function()
	while true do
		task.wait(1)
		local now = os.clock()
		if dirtyAt and not isSending and now - dirtyAt >= QUIET_SECONDS and now >= retryAt then
			send()
		end
	end
end)
