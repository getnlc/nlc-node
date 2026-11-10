# NLC Node

NLC Node is a small program a customer installs on their own Mac or Windows computer so their NLC assistant can work with the folders they choose. It is made by FTay Consulting Sdn Bhd.

This repository holds NLC Node's own source code and nothing else. It does not hold NLC itself, any customer data or any secret. It is published so that you, or an AI assistant you ask, can read exactly what is installed on your computer before you install it.

## Where to start

- [WHAT-IT-CAN-REACH.md](WHAT-IT-CAN-REACH.md): what NLC Node can and cannot touch, and every network address it contacts.
- [CHECKSUMS.md](CHECKSUMS.md): the SHA-256 of every published version, and of the install scripts.
- [VERIFY.md](VERIFY.md): how to download the install script, check it, read it and run that copy.
- [REMOVE.md](REMOVE.md): how to remove NLC Node completely.

## What is here

| Folder | What it is |
| --- | --- |
| `lib/nlc-node` | The program: the local window, the folder rules, the connection to your own NLC, the file, video and speech tools. |
| `scripts/nlc-node` | How a release is built and how this repository is made. |
| `installer/nlc-node` | The Mac and Windows installers and the one-line install scripts (`one-line/`). |
| `tests/nlc-node` | NLC Node's own tests that run on their own. 8 further tests need parts of NLC that are not published and are left out. |

Each install script has two placeholders, `__NLC_ORIGIN__` (the address of your own NLC) and `__NLC_LINK__` (a one-time connection link, if you were given one). Your NLC fills them in when it serves the script.

## Installing

NLC Node is installed from the link your own NLC gives you (it looks like `https://your-NLC-address/node`). That page carries your NLC's address, the one-line command for a person, and the same install as steps for an AI assistant. This repository is the place to check what that page tells you.

Repository: https://github.com/getnlc/nlc-node

## Licence

Copyright FTay Consulting Sdn Bhd. Published so that anyone can read what runs on their computer. No licence to copy, change or redistribute it is granted.
