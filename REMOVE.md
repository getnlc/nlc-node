# Removing NLC Node

## Mac

```
curl -fsSL "https://<your-NLC-address>/downloads/nlc-node/install.sh" | sh -s -- --uninstall
```

## Windows

```
$env:NLC_NODE_UNINSTALL='1'; irm "https://<your-NLC-address>/downloads/nlc-node/install.ps1" | iex
```

The program, its own settings and state, the start-at-login entry.

It leaves: Every file in the user's own folders and the NLC Trash folder, exactly as they were.
