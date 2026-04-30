# JSON Editor for Devcontainer Override — Design Spec

**Date:** 2026-04-21

## Summary

Replace the plain `<textarea>` used for the devcontainer override JSON field with a proper CodeMirror 6 editor. Simultaneously, expand the New Project form to expose all the same fields that Edit Project already has.

## Scope

### In scope
- Upgrade the devcontainer override JSON field (Edit Project page) from `<textarea>` to CodeMirror 6.
- Add the devcontainer JSON editor to the New Project page.
- Add all missing fields to New Project: git author name, git author email, extra plugin marketplaces, extra plugins.
- Editor theme follows app dark/light mode (class-based, toggled on `document.documentElement`).

### Out of scope
- JSON schema validation against the devcontainer spec.
- JSON auto-formatting / prettify button.
- Any other form fields beyond what Edit Project already has.

## New Packages

```
@uiw/react-codemirror     # React wrapper for CodeMirror 6
@codemirror/lang-json     # JSON language + inline error linting
```

## Component: `JsonEditor`

**File:** `src/web/components/JsonEditor.tsx`

**Props:**
```ts
interface JsonEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}
```

**Behaviour:**
- Renders a labelled CodeMirror editor (matching the `Text`/`Area` label style already used in the forms).
- Dark mode: reads `document.documentElement.classList.contains('dark')` on mount and watches for changes via `MutationObserver`. Passes `oneDark` extension when dark, no theme (default light) otherwise.
- JSON language: `json()` extension from `@codemirror/lang-json`, which provides syntax highlighting and inline parse-error squiggles.
- Live validation status bar beneath the editor: "✓ Valid JSON" (green) or "✗ Error: \<message\>" (red), computed by `JSON.parse` on every change.
- The editor is not read-only; it replaces the textarea entirely.

## Page Changes

### `EditProject.tsx`
- Replace `<Area label="Devcontainer override JSON ..." />` with `<JsonEditor label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)" ... />`.
- No other changes to the file.

### `NewProject.tsx`
- Add state for the five missing fields: `gitAuthorName`, `gitAuthorEmail`, `marketplaces` (string[]), `plugins` (string[]), `devcontainerOverrideJson` (string | null).
- Add form fields in the same order as Edit Project:
  1. Git author name (Text input, optional)
  2. Git author email (Text input, optional)
  3. Instructions (textarea, already present)
  4. Extra plugin marketplaces (textarea, one per line)
  5. Extra plugins (textarea, one per line)
  6. Devcontainer override JSON (`JsonEditor`)
- Wire all new fields into the `api.createProject()` call (replacing the hardcoded `null`/`[]` values).
- Duplicate the `splitLines` helper locally (it's a one-liner; no shared file needed).

## Form Field Order (New Project)

1. Name *(required)*
2. Repo URL *(required)*
3. Default Branch *(required)*
4. Git author name override *(optional)*
5. Git author email override *(optional)*
6. Project-level instructions *(optional)*
7. Extra plugin marketplaces *(optional)*
8. Extra plugins *(optional)*
9. Devcontainer override JSON *(optional, CodeMirror editor)*
10. Create button

## Dark Mode Integration

The `JsonEditor` component detects the active theme by inspecting `document.documentElement.classList` on mount and via a `MutationObserver` that fires when the classList changes. This avoids any prop drilling or context dependency while reacting correctly when the user toggles theme mid-session.

```ts
const [isDark, setIsDark] = useState(() =>
  document.documentElement.classList.contains('dark')
);

useEffect(() => {
  const observer = new MutationObserver(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  });
  observer.observe(document.documentElement, { attributeFilter: ['class'] });
  return () => observer.disconnect();
}, []);
```

## Validation Status Bar

Below the editor, a single line shows parse status on every keystroke:

- **Valid:** green text, "✓ Valid JSON"
- **Empty:** neutral, no indicator shown (empty string is allowed — field is optional)
- **Invalid:** red text, "✗ \<error message from JSON.parse\>"

The status bar does not block form submission (the field is optional and an empty value is stored as `null`).
