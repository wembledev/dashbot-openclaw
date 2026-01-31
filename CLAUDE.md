# dashbot-openclaw

OpenClaw channel plugin for [DashBot](https://github.com/wembledev/dashbot). TypeScript 5.9, Vitest, ESLint.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode (`tsc --watch`) |
| `npm test` | Vitest test suite |
| `npm run test:watch` | Vitest watch mode |
| `npm run check` | TypeScript type-check (no emit) |
| `npm run lint` | ESLint |

## Architecture

This plugin connects an OpenClaw gateway to a DashBot Rails server over Action Cable (WebSocket), with an HTTP POST fallback.

### Directory layout

```
index.ts                 # Plugin entry — registers channel with OpenClaw
src/
  channel.ts             # ChannelPlugin — startAccount, dispatches inbound messages
  connection.ts          # DashBotConnection — Action Cable WebSocket client
  outbound.ts            # createOutbound — send responses via WS or HTTP fallback
  types.ts               # TypeScript interfaces (config, messages, cable protocol)
test/
  connection.test.ts     # WebSocket + Action Cable protocol tests
  outbound.test.ts       # WS send + HTTP fallback tests
  channel.test.ts        # ChannelPlugin integration tests
```

### Key wiring

- **Entry**: `index.ts` exports a plugin object with `register(api)` that calls `api.registerChannel()`
- **Connection**: `DashBotConnection` implements the Action Cable WebSocket protocol (connect → welcome → subscribe → confirm → bidirectional messages)
- **Outbound**: Sends assistant responses via WebSocket, falls back to HTTP POST to `/api/messages/respond`
- **Channel**: `dashbotPlugin.startAccount(ctx)` creates a connection, listens for user messages, and dispatches them to the OpenClaw runtime

## Code Conventions

- ES modules (`"type": "module"` in package.json)
- Strict TypeScript: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- `.js` extensions in imports (required for ESM resolution)
- ESLint: `@eslint/js` recommended + `typescript-eslint` recommended

## Testing

- Tests in `test/` mirroring `src/` structure
- Vitest with globals enabled: `describe`, `it`, `expect`, `vi` — no imports needed
- Mock WebSocket: `vi.stubGlobal("WebSocket", MockWebSocket)`
- Mock fetch: `vi.spyOn(globalThis, "fetch").mockResolvedValue(...)`
- Cleanup: `vi.restoreAllMocks()` in `beforeEach`

## Related

- [DashBot](https://github.com/wembledev/dashbot) — Rails app (dashboard, API, Action Cable server)
- [OpenClaw](https://openclaw.ai/) — AI agent gateway
