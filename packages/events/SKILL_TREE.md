flowchart LR

subgraph 0["src"]
subgraph 1["collections"]
2["EventCollection.ts"]
5["EventParticipantCollection.ts"]
8["EventSeriesCollection.ts"]
A["EventTypeCollection.ts"]
end
subgraph 3["models"]
4["Event.ts"]
6["EventParticipant.ts"]
9["EventSeries.ts"]
B["EventType.ts"]
end
7["types.ts"]
C["index.ts"]
D["utils.ts"]
subgraph E["manifest"]
F["test-manifest-stub.ts"]
end
end
2-->4
2-->7
4-->2
4-->5
4-->8
4-->A
4-->7
5-->6
5-->7
6-->2
6-->5
6-->7
8-->9
8-->7
9-->2
9-->A
9-->7
A-->B
B-->7
C-->2
C-->5
C-->8
C-->A
C-->4
C-->6
C-->9
C-->B
C-->7
C-->D
D-->7
