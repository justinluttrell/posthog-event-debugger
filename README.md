# PostHog Event Debugger

An unofficial, community-developed Chrome extension to monitor and debug PostHog events in real-time.

<img width="601" height="602" alt="image" src="https://github.com/user-attachments/assets/bb8f077c-983d-411f-8c3e-a78818c6e22f" />


## Installation

1. Install dependencies:
   ```bash
   cd ~/dev/posthog-event-debugger
   bun install
   ```

2. Build the extension:
   ```bash
   bun run build
   ```

3. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

## Development

```bash
# Build once
bun run build

# Watch mode (rebuilds automatically on file changes)
bun run dev
```

## Usage

1. Click the extension icon in Chrome toolbar
2. Navigate to a page that uses PostHog
3. Events will appear in the popup as they're captured

## Contributing

Contributions are welcome! If you have ideas for improvements, bug reports, or feature requests, please feel free to open an issue or pull request on GitHub.
