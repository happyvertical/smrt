flowchart LR

subgraph 0["src"]
1["index.ts"]
subgraph 2["tools"]
3["ask.ts"]
6["get-docs.ts"]
7["list-packages.ts"]
end
4["registry.ts"]
5["router.ts"]
subgraph 8["manifest"]
9["test-manifest-stub.ts"]
end
end
1-->3
1-->6
1-->7
3-->4
3-->5
5-->4
6-->4
7-->4
