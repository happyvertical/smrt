<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
import ContentTransparencyReport from '../../../svelte/components/ContentTransparencyReport.svelte';
import Markdown from '../../../svelte/components/Markdown.svelte';

let { data } = $props<{
  data: {
    content: {
      title?: string;
      description?: string | null;
      body?: string | null;
      author?: string | null;
      publish_date?: string | null;
      slug?: string | null;
    };
    transparency: any;
  };
}>();

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'Unscheduled';
  }

  return new Date(value).toLocaleString();
}
</script>

<ThemeProvider colorScheme="system" persist={true}>
  <div class="article-page">
    <header class="article-hero">
      <div class="article-hero__inner">
        <a href="/workspace" class="back-link">Back to content workspace</a>
        <div class="eyebrow">Published article</div>
        <h1>{data.content.title || 'Untitled article'}</h1>
        {#if data.content.description}
          <p class="article-dek">{data.content.description}</p>
        {/if}

        <div class="article-meta">
          <span>{data.content.author || 'Unknown author'}</span>
          <span>{formatTimestamp(data.content.publish_date)}</span>
          {#if data.content.slug}
            <span>/{data.content.slug}</span>
          {/if}
        </div>
      </div>
    </header>

    <main class="article-layout">
      <article class="article-body">
        <Markdown content={data.content.body || ''} />
      </article>

      <aside class="article-sidebar">
        <ContentTransparencyReport
          transparency={data.transparency}
          title="How this article was made"
          emptyCopy="This published article does not have a public transparency snapshot yet."
        />
      </aside>
    </main>
  </div>
</ThemeProvider>

<style>
  :global(body) {
    margin: 0;
    font-family:
      var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont,
      'Segoe UI', Roboto, sans-serif);
    background:
      radial-gradient(
        circle at top,
        color-mix(in srgb, var(--smrt-color-primary) 10%, transparent),
        transparent 34%
      ),
      var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    min-height: 100vh;
  }

  .article-page {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }

  .article-hero,
  .article-layout {
    max-width: 1280px;
    margin: 0 auto;
  }

  .article-hero {
    margin-bottom: 2rem;
  }

  .article-hero__inner {
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    box-shadow: var(--smrt-elevation-2, 0 12px 40px rgba(15, 23, 42, 0.08));
    border-radius: 1.25rem;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .back-link {
    color: var(--smrt-color-primary);
    text-decoration: none;
    font-weight: 600;
    width: fit-content;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  .eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .article-hero h1 {
    margin: 0;
    font-size: clamp(2.2rem, 5vw, 4rem);
    line-height: 1.05;
    color: var(--smrt-color-on-surface);
  }

  .article-dek {
    margin: 0;
    font-size: 1.15rem;
    color: var(--smrt-color-on-surface-variant);
    max-width: 55rem;
  }

  .article-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.85rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.92rem;
  }

  .article-layout {
    display: grid;
    gap: 1.5rem;
  }

  .article-body,
  .article-sidebar {
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    border-radius: 1.25rem;
    padding: 1.5rem;
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
  }

  .article-body {
    min-width: 0;
  }

  @media (min-width: 1080px) {
    .article-layout {
      grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
      align-items: start;
    }

    .article-sidebar {
      position: sticky;
      top: 1.5rem;
    }
  }
</style>
