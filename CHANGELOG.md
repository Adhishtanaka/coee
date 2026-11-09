# Changelog

## 1.0.0
- Initial release.
- Reads the whole project. A code index finds every function, route, data shape (DTO), business rule and entry point without the model, and a pr-agent-style packer shows the model the most important files whole and the rest as outlines, instead of skipping them. Diffs are compressed the same way.
- One coee column: every coee page opens as a tab in one group beside your code, with the same switcher on each page.
- Walkthroughs: explain lines, a function, a file or a folder step by step beside the code, with flow, sequence and state diagrams. Each step can be made simpler, deeper or line by line, or you can ask your own question.
- Architecture overview: how the project works, every component and how they connect, use cases with sequence diagrams, lifecycles as state diagrams, and the data model as an ER diagram. **Walk me through** starts a walkthrough for any component or use case, and the page follows the walkthrough as it moves. File links select the exact lines. **Find** answers where something is handled, and big repositories start at their packages.
- Changes: a live review of your git changes, with fast checks on every save and model reviews on stage or save. Findings appear as comments on the lines, in the Problems panel and in the status bar, with suggestions you can apply. Also includes a suggested commit message, branch vs main, and explaining any commit.
- Plan a change: integration points, affected components, risks and an order of work, against your real code, with the code to add and always its tests. Snippets are placed by the code around them, previewed, checked after adding, and never added twice.
- Security scan: for a file, folder or project. Fast rules, then dependency advisories (npm audit, pip-audit or OSV.dev), then the model confirms each finding and finds logic flaws. Findings are grouped by OWASP category, each with an attack diagram, a fix and a test. Also adds Problems panel entries with quick fixes, dismissals and SARIF export.
