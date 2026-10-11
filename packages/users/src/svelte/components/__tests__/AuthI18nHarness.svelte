<script lang="ts">
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import type { UsersAuthAdapter } from '../../auth.js';
import AccountSecurityPanel from '../AccountSecurityPanel.svelte';
import MagicLinkForm from '../MagicLinkForm.svelte';
import OidcProviderButtons from '../OidcProviderButtons.svelte';
import PasskeySignInButton from '../PasskeySignInButton.svelte';
import SignInForm from '../SignInForm.svelte';
import SignUpForm from '../SignUpForm.svelte';

interface Props {
  adapter?: UsersAuthAdapter;
  view?:
    | 'default'
    | 'sign-in'
    | 'sign-up'
    | 'magic-link'
    | 'oidc'
    | 'passkey'
    | 'security';
  token?: string;
}
let {
  adapter = {
    signInWithPassword: async () => {},
    signInWithPasskey: async () => {},
  },
  view = 'default',
  token,
}: Props = $props();
const french = {
  'users.auth.email_address': 'Adresse e-mail',
  'users.auth.password': 'Mot de passe',
  'users.auth.confirm_password': 'Confirmer le mot de passe',
  'users.auth.sign_in': 'Se connecter',
  'users.auth.create_account': 'Créer un compte',
  'users.auth.passkey_sign_in': 'Utiliser une clé d’accès',
  'users.auth.send_sign_in_link': 'Envoyer le lien',
  'users.auth.confirm_sign_in': 'Confirmer la connexion',
  'users.auth.sign_out': 'Se déconnecter',
  'users.auth.revoke': 'Révoquer',
  'users.auth.unable_to_sign_in': 'Impossible de se connecter.',
  'users.auth.unable_to_create_account': 'Impossible de créer le compte.',
  'users.auth.unable_to_continue_link': 'Impossible de continuer avec le lien.',
  'users.auth.unable_to_start_sso':
    'Impossible de démarrer la connexion unique.',
  'users.auth.passkey_not_completed':
    'La connexion avec la clé d’accès a échoué.',
  'users.auth.unable_to_revoke_session': 'Impossible de révoquer la session.',
  'users.auth.unable_to_revoke_api_key': 'Impossible de révoquer la clé API.',
  'users.auth.passwords_do_not_match':
    'Les mots de passe ne correspondent pas.',
  'users.auth.link_sent':
    'Consultez votre messagerie pour le lien de connexion.',
  'users.auth.link_confirmed': 'Votre lien de connexion a été confirmé.',
};
const i18n = setI18nContext(
  createI18nContext({ locale: 'fr', messages: french }),
);
function switchLocale() {
  i18n.snapshot =
    i18n.locale === 'fr'
      ? { locale: 'en', messages: {} }
      : { locale: 'fr', messages: french };
}
</script>

<button onclick={switchLocale}>Switch locale</button>
{#if view === 'default' || view === 'sign-in'}
  <SignInForm {adapter} />
{/if}
{#if view === 'default' || view === 'passkey'}
  <PasskeySignInButton {adapter} />
{:else if view === 'sign-up'}
  <SignUpForm {adapter} />
{:else if view === 'magic-link'}
  <MagicLinkForm {adapter} {token} />
{:else if view === 'oidc'}
  <OidcProviderButtons {adapter} providers={[{ id: 'work', label: 'Work SSO' }]} />
{:else if view === 'security'}
  <AccountSecurityPanel {adapter} sessions={[{ id: 's1', label: 'Laptop' }]} apiKeys={[{ id: 'k1', label: 'Automation' }]} />
{/if}
