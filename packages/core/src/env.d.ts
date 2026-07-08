// The synced engine references Vite's `import.meta.env.DEV` for a dev-only debug
// hook. tsup compiles that to `false` for the published build (see tsup.config.ts);
// this ambient type just satisfies the declaration build.
interface ImportMeta {
  readonly env: {
    readonly DEV: boolean;
    readonly [key: string]: unknown;
  };
}
