<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const { siteConfig } = data;
</script>

<svelte:head>
  <title>Contact - {siteConfig.name}</title>
  <meta name="description" content="Contact {siteConfig.name}" />
</svelte:head>

<div class="contact">
  <h1>Contact {siteConfig.name}</h1>

  <section>
    <h2>Get in Touch</h2>
    <p>
      Have a question, feedback, or news tip? We'd love to hear from you.
    </p>
    <p>
      <strong>Email:</strong> <a href="mailto:contact@{{PACKAGE_NAME}}.com">contact@{{PACKAGE_NAME}}.com</a>
    </p>
  </section>

  <section>
    <h2>Submit a Tip</h2>
    <p>
      Know about an upcoming event, a community story, or something happening in {siteConfig.location.name}?
      Send us a message and we'll look into it.
    </p>
  </section>

  <section>
    <h2>Official Resources</h2>
    <p>
      For official government business, please contact your local government directly.
    </p>
  </section>

  <section class="disclaimer">
    <h2>Disclaimer</h2>
    <p>
      {siteConfig.name} is an independent community news service. We are not affiliated with
      any government entity. Our coverage is based on publicly available documents and official sources.
    </p>
  </section>
</div>

<style>
  .contact {
    max-width: 700px;
  }

  h1 {
    font-size: var(--font-size-2xl);
    margin-bottom: var(--spacing-xl);
    color: var(--color-neutral-gray900);
  }

  section {
    margin-bottom: var(--spacing-xl);
  }

  h2 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-md);
    color: var(--color-neutral-gray800);
  }

  p {
    line-height: 1.7;
    color: var(--color-neutral-gray700);
    margin-bottom: var(--spacing-md);
  }

  a {
    color: var(--color-primary);
  }

  .disclaimer {
    padding: var(--spacing-lg);
    background: var(--color-neutral-gray100);
    border-radius: var(--radius-md);
  }

  .disclaimer h2 {
    font-size: var(--font-size-md);
  }

  .disclaimer p {
    font-size: var(--font-size-sm);
    margin-bottom: 0;
  }
</style>
