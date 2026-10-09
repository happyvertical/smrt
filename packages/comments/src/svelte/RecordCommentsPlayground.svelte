<script lang="ts">
import { recordCommentsDemo } from './demo.js';
import RecordComments, {
  type RecordCommentView,
} from './RecordComments.svelte';

let comments = $state<RecordCommentView[]>(
  recordCommentsDemo.map((comment) => ({ ...comment })),
);
let nextId = 3;
function addComment(body: string) {
  comments = [
    ...comments,
    { id: `demo-comment-${nextId++}`, authorLabel: 'You', body },
  ];
}
</script>

<p>Sample record discussion. Comments stay in this preview and do not send notifications.</p>
<RecordComments contextKey="playground:sample-record" {comments} onsubmit={addComment} />
