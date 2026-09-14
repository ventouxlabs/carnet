# iOS share extension preparation

**Status:** implementation-ready preparation only — no macOS/Xcode/signing
environment is available in this workspace as of 2026-09-13.

## Product contract

The extension accepts text, URLs, and supported image/file inputs. It creates a
small, durable **shared inbox item**; the foreground Carnet app validates and
consumes that item through the existing capture/dispatcher path. It must not
perform enrichment or a long upload inside the extension's short-lived process.

The app consumes each inbox item idempotently into the selected vault. It shows
a recoverable error for an unavailable vault or expired file permission rather
than discarding user input.

## Ownership and storage

- Use an App Group container for the inbox record and its lightweight metadata.
- Use security-scoped bookmark/file-access handling for files outside the group;
  start/stop access in the owning process and treat stale/expired bookmarks as
  recoverable input failures.
- Store stable item ids and a processing state so duplicate extension delivery,
  foreground-app restart, and interrupted handoff do not create duplicate notes.
- The app, not the extension, resolves the active vault context at consumption
  time and pins it through the complete capture operation.
- Large attachments are copied/retained according to a bounded quota before
  acknowledgement; failed copies leave the inbox item retryable.

## Required behavior tests

The future iOS target must cover:

- text, URL, image, and supported-file normalization;
- unsupported attachment and empty-share rejection;
- duplicate delivery and idempotent consumption;
- extension termination before and after inbox persistence;
- expired/missing security-scoped bookmark;
- unavailable/revoked vault access;
- large attachment and quota failure;
- migration of an inbox item across app upgrade;
- selected-vault pinning while a user changes vaults during enrichment;
- Relais/remote-provider unavailable outcomes that preserve the captured input.

A shared pure envelope validator may live in the JavaScript workspace only when
both the Android receive flow and the future iOS bridge actually use it. Do not
introduce a speculative abstraction with no production caller.

## Prerequisites for implementation

1. A macOS host with a supported Xcode version.
2. Apple Developer team, bundle identifiers, provisioning profiles, and App
   Group entitlement agreed by the product owner.
3. An iOS device matrix covering a fresh install, upgrade, locked device,
   low-storage condition, and an app process that is not already running.
4. An Expo prebuild/native-module compatibility review before changing the
   managed project.

No signing identifier, entitlement value, or iOS binary is asserted by this
document. Until those prerequisites are available, this is preparation—not a
shipped iOS share extension.
