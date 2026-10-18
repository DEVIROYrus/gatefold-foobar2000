# Code signing

Unsigned installers trigger Microsoft Defender SmartScreen (“Windows protected your PC”) and some antivirus heuristics — especially an installer that runs other installers. The plan:

## SignPath Foundation (free for open-source projects)

Requirements (from signpath.org/terms): an OSI-approved license (MIT ✓), no proprietary components in the signed binary (the installer bundles foobar2000's freeware installer unmodified — ask SignPath whether that is acceptable, or switch the installer to download foobar2000 at install time for the signed build), automated builds from this repository (GitHub Actions ✓), MFA for all maintainers, a manual approval for every release, and a code signing policy on the project page (below).

Steps after acceptance:
1. Add the repository secret `SIGNPATH_API_TOKEN` and the variable `SIGNPATH_ORGANIZATION_ID`.
2. In `release.yml`, upload `dist/Gatefold-Setup-*.exe` with `actions/upload-artifact@v4` (id → `steps.<id>.outputs.artifact-id`), then call `signpath/github-action-submit-signing-request@v1` with that artifact id, `project-slug: gatefold-foobar2000`, `signing-policy-slug: release-signing`, `wait-for-completion: true`, `output-artifact-directory: dist/signed`, and publish the signed file.

## Code signing policy (to publish in the README once signing is active)

> Free code signing provided by SignPath.io, certificate by SignPath Foundation.
> Committers and reviewers: the members of this repository. Approvers: the repository owner.
> Privacy: this program does not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it (see the Privacy section of the README).

## Alternatives

Azure Artifact Signing (formerly Trusted Signing), $9.99/month, currently for individuals in the USA and Canada and organisations in the EU, UK, USA and Canada. A classic OV certificate gains SmartScreen reputation only gradually.
