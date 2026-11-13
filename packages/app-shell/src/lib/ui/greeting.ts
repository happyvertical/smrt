// The home page greeting. The owner's name comes from the session layout
// (`session.user.name`, read from the profile by app-runtime); a desktop owner
// has a name and an EMPTY email, so the email is never the greeting.

/** "Hello, Ada." with a name, plain "Hello." without one. */
export function greeting(
  user: { name?: string | null } | null | undefined,
): string {
  const name = user?.name?.trim();
  return name ? `Hello, ${name}.` : 'Hello.';
}
