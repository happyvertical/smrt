# `inference:hosted`: one group, several owners (#4760, #4759)

`src/commands/inference-hosted.ts` dispatches `smrt inference:hosted
<subcommand>` from `INFERENCE_HOSTED_SUBCOMMANDS`; each owner adds its
subcommands from its own module (#4760: `inference-hosted-switch.ts`
`disable | enable | status`; #4759: `inference-hosted-provision.ts`
`provision | revoke`, which mint and revoke a user's gateway key through
`createHostedInferenceProvisioner()` and never print the key). The group's
options are the union of its subcommands' options. The kill switch
is the incident lever: `disable` writes the `inference.hosted.enabled`
DISABLE row (global or `--tenant`), `enable` deletes it, `status` reads it;
the gate reads it uncached, so it applies on the next hosted call without a
restart or model call. A tenant `enable` under a global disable says it is
still disabled. smrt-features is loaded from the project at run time (the
CLI cannot depend on it: smrt-features builds with the CLI); a missing
package or table fails with a `db:migrate` hint. Database credentials are
the authorization.
