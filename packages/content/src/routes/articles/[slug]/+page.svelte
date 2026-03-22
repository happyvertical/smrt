<script lang="ts">
import type { PublishedContentArticleRouteData } from '../../../route-module.js';
import { CONTENT_ROUTE_MODULE } from '../../../route-module.js';

const ArticleRoute = CONTENT_ROUTE_MODULE.routes.article.component;

let { data } = $props<{
  data: PublishedContentArticleRouteData;
}>();
</script>

<ArticleRoute {data} />
