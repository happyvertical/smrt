flowchart LR

subgraph 0["src"]
subgraph 1["federation"]
2["index.ts"]
end
3["index.ts"]
subgraph 4["protocols"]
5["index.ts"]
end
subgraph 6["manifest"]
7["test-manifest-stub.ts"]
end
end
3-->2
3-->5
