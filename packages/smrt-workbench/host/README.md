# s-m-r-t Workbench Host

Private SvelteKit host bundled inside `@happyvertical/smrt-workbench`.

Run the public launcher from the s-m-r-t workspace or a consumer project:

```bash
smrt workbench dev
```

The launcher binds to loopback by default. Remote binding requires the explicit
`--allow-remote` acknowledgement and should only be used on a trusted network.
