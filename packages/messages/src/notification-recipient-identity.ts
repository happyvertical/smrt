/** Reserved profile policy identity: a clone retaining this kind cannot become a User send. */
export const PROFILE_NOTIFICATION_POLICY_PREFIX = 'profile:';
/** Build the canonical profile-only policy ID used in the trusted dispatchPolicies map. */
export function profileNotificationPolicy(hostPolicyId: string): string {
  if (
    typeof hostPolicyId !== 'string' ||
    !hostPolicyId.trim() ||
    hostPolicyId !== hostPolicyId.trim() ||
    /[\s\r\n]/u.test(hostPolicyId) ||
    hostPolicyId.startsWith(PROFILE_NOTIFICATION_POLICY_PREFIX)
  )
    throw new Error(
      'Choose an exact non-prefixed host notification policy ID.',
    );
  return `${PROFILE_NOTIFICATION_POLICY_PREFIX}${hostPolicyId}`;
}
export interface NotificationRecipientIdentity {
  recipientKind: 'user' | 'profile';
  recipientUserId: string | null;
  recipientProfileId: string | null;
  channel: string;
  kind: string;
  requiredDispatchPolicy: string;
}
/** Shared save/enqueue/lease/canonical-send guard, independent of model registration. */
export function assertNotificationRecipientIdentity(
  row: { [K in keyof NotificationRecipientIdentity]: unknown },
): void {
  if (
    typeof row.requiredDispatchPolicy !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.channel !== 'string'
  )
    throw new Error('Malformed typed notification identity.');
  const profilePolicy =
    row.requiredDispatchPolicy.startsWith(PROFILE_NOTIFICATION_POLICY_PREFIX) &&
    row.requiredDispatchPolicy.length >
      PROFILE_NOTIFICATION_POLICY_PREFIX.length;
  const reserved =
    row.kind.startsWith('protected:profile:') ||
    row.requiredDispatchPolicy.startsWith(PROFILE_NOTIFICATION_POLICY_PREFIX);
  const nonempty = (value: unknown) =>
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value === value.trim();
  const valid =
    row.recipientKind === 'user'
      ? nonempty(row.recipientUserId) &&
        row.recipientProfileId === null &&
        !reserved
      : row.recipientKind === 'profile' &&
        row.recipientUserId === null &&
        nonempty(row.recipientProfileId) &&
        row.channel === 'email' &&
        profilePolicy &&
        row.kind === `protected:${row.requiredDispatchPolicy}`;
  if (!valid)
    throw new Error(
      'Notification requires exactly one matching typed recipient and reserved protected email policy for profiles.',
    );
}
