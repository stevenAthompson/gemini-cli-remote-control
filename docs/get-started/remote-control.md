# Remote Control API

The Gemini CLI includes an experimental RESTful Remote Control server that
allows external scripts, dashboards, and tools to monitor and interact with an
active CLI session programmatically.

## Configuration

To use the remote control API, enable it in your `settings.json` file. By
default, it listens on port `25418`.

```json
{
  "remoteControl": {
    "enabled": true,
    "port": 25418
  }
}
```

The server binds strictly to `127.0.0.1` (localhost) to ensure the API is only
accessible locally.

## Endpoints

### 1. `GET /status`

Returns the current state of the CLI.

**Response (JSON)**

```json
{
  "status": "Waiting for input",
  "streamingState": "idle",
  "isInputActive": true,
  "isWaitingForConfirmation": false
}
```

**State Mappings:**

- **`Busy`**: The model is actively streaming a response
  (`streamingState === 'responding'`).
- **`Waiting for confirmation`**: A tool call is paused, waiting for the user to
  approve or deny the action.
- **`Waiting for input`**: The command prompt is active, waiting for the user to
  type a message or command.
- **`Error`**: A fatal initialization or authentication error is present.
- **`Idle`**: The system is not busy, not waiting for confirmation, and the
  input prompt is not active (e.g., during initialization or while a background
  task is executing without prompting).

### 2. `GET /screen`

Returns a placeholder string indicating that screen capture is not fully
supported in this version. _Note: Direct screen buffer capture via Ink is
unsupported without stream interception._

### 3. `GET /history?lines=<number|ALL>`

Returns the chat session history.

- **Default:** `GET /history` returns the last 100 history items.
- **Custom limit:** `GET /history?lines=50` returns the last 50 items.
- **Full history:** `GET /history?lines=ALL` returns the complete session
  history.

**Response (JSON Array)**

```json
[
  {
    "type": "user",
    "text": "Hello Gemini"
  },
  {
    "type": "gemini",
    "text": "Hello! How can I help you today?"
  }
]
```

### 4. `POST /input`

Injects text into the CLI as if the user typed it and pressed Enter. This is
useful for automating commands from external tools.

**Request (JSON)**

```json
{
  "input": "Summarize the last commit\r"
}
```

_Note: Make sure to include carriage returns (`\r`) or newlines if you want to
submit the input immediately._

**Response (JSON)**

```json
{
  "success": true
}
```
