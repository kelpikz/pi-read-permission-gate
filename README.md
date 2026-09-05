# pi-read-permission-gate

A [Pi](https://pi.dev) package that installs a permission-gate extension.

The extension allows read-only operations by default and asks for confirmation before non-read actions. In non-interactive modes, non-read tool calls are blocked because there is no UI available for confirmation.

## Behavior

Allowed without prompting:

- `read` tool calls
- Conservative read-only shell commands through `bash`, including `ls`, `pwd`, `rg`, `grep`, `find`, `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `true`, and `cd`

Prompts before allowing:

- `write`
- `edit`
- non-read `bash` commands
- any other tool call

When prompted, you can:

- Allow
- Allow for this session
- Deny
- Deny with a reason

For parallel tool calls, the prompt lists only the calls that need permission. Choosing "Allow for this session" approves those listed calls, while read-only calls in the same batch stay out of the list.

## Install from GitHub

After publishing this directory as its own GitHub repository, users can install it with:

```bash
pi install git:github.com/<user-or-org>/pi-read-permission-gate
```

With a pinned tag or commit:

```bash
pi install git:github.com/<user-or-org>/pi-read-permission-gate@v0.1.0
```

## Install from npm

If published to npm:

```bash
pi install npm:pi-read-permission-gate
```

## Local development

From this directory:

```bash
pi install ./
```

Or from the parent Pi repo checkout:

```bash
pi install ./extensions/read-permission-gate
```

Try it for one run without installing:

```bash
pi -e ./
```

After editing the extension, run `/reload` inside Pi.

If you already have an older standalone copy at:

```text
~/.pi/agent/extensions/read-permission-gate.ts
```

remove it before installing this package, otherwise Pi may load the extension twice:

```bash
rm ~/.pi/agent/extensions/read-permission-gate.ts
pi install ./
```

## Package layout

```text
src/read-permission-gate.ts  # extension entrypoint
package.json                  # Pi package manifest
```

The `package.json` contains:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/read-permission-gate.ts"]
  }
}
```

Pi reads this manifest and loads the extension when the package is installed.

## Development checks

```bash
npm install
npm run check
npm run pack:dry-run
```
