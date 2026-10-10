<script lang="ts">
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import PasskeySignInButton from '../PasskeySignInButton.svelte';
import SignInForm from '../SignInForm.svelte';

const passkeyCeremony = () => Promise.resolve();
setI18nContext(
  createI18nContext({
    locale: 'fr',
    messages: {
      'users.auth.email_address': 'Adresse e-mail',
      'users.auth.password': 'Mot de passe',
      'users.auth.sign_in': 'Se connecter',
      'users.auth.passkey_sign_in': 'Utiliser une clé d’accès',
    },
  }),
);
</script>

<SignInForm adapter={{ signInWithPassword: async () => {} }} />
<PasskeySignInButton adapter={{ signInWithPasskey: passkeyCeremony }} />
