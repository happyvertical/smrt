flowchart LR

subgraph 0["src"]
subgraph 1["collections"]
2["PlaceCollection.ts"]
5["PlaceTypeCollection.ts"]
end
subgraph 3["models"]
4["Place.ts"]
6["PlaceType.ts"]
end
7["types.ts"]
8["index.ts"]
9["utils.ts"]
subgraph A["manifest"]
B["test-manifest-stub.ts"]
end
end
2-->4
2-->7
2-->5
4-->2
4-->5
4-->7
5-->6
6-->7
8-->2
8-->5
8-->4
8-->6
8-->7
8-->9
9-->7
