flowchart LR

subgraph 0["src"]
1["index.ts"]
2["loader.ts"]
3["types.ts"]
4["merge.ts"]
end
1-->2
1-->4
1-->3
1-->3
2-->3
4-->3
