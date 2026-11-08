# coee

Understand any codebase without leaving VS Code. coee explains code step by step beside the source, describes how a project is put together, reviews changes and plans new work. It never edits your files.

<img src="media/screenshots/walkthrough.png" alt="The architecture overview: a summary of the project, how it works, and a diagram of its components and how they connect" width="560">

## Features

**Walkthroughs.** Click **Explain** above any function or class, or use the book icon to explain a whole file. Each step highlights the relevant lines and explains them in plain language, with a flow, sequence or state diagram where a picture helps. On any step you can ask for a **Simpler** or **Deeper** explanation, go **Line by line**, or ask your own question.

**Architecture overview.** One page that describes the project: how it works, every component and how they connect, the main use cases with sequence diagrams, lifecycles as state diagrams, and the data model as an ER diagram.

**System map.** The project's components and what passes between them. Select a part to see its code and connections, ask about it, or open it in the architecture overview.

**Review changes.** Explain staged changes before you commit (with a suggested commit message), any commit, your branch compared with main, or a GitHub pull request. Each review covers what changed and what is worth checking, with additions and removals marked in the code.

**Plan a change.** Describe a feature or technology you want to introduce. coee identifies the integration points, the affected components, the risks and a sensible order of work, against your real code.

## Getting started

1. Make sure a chat model is available in VS Code, for example GitHub Copilot.
2. Open a file and click **Explain** above a function, or right-click and choose **coee**.

| Where | What you can do |
|---|---|
| Editor, right-click → **coee** | Explain lines or a file, ask a question, plan a change, open the architecture overview or system map, review changes |
| Explorer, right-click → **coee** | Explain a file or folder, plan a change, open the architecture overview or system map |
| Source Control title bar | Review before commit, review changes |
| Source Control Graph, right-click a commit | Explain a commit |

## Settings

| Setting | Default | Description |
|---|---|---|
| `coee.codeLens` | `true` | Show **Explain** above functions, methods and classes |
| `coee.cache` | `true` | Keep finished explanations so reopening is instant. The setting includes a **Clear cache** link |
| `coee.modelFamily` | | Preferred chat model, for example `gpt-4o`. Empty uses the first available model |

## Privacy

coee sends the code it explains to the chat model selected in VS Code, through the VS Code Language Model API. It does not need its own API key and never modifies your files. Pull requests are read with your own GitHub CLI (`gh`) sign-in.

## Development

```sh
npm install && npm test   # build and run the tests
npm run package           # create coee-x.y.z.vsix
```
