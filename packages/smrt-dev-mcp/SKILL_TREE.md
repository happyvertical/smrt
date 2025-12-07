flowchart LR

subgraph 0["src"]
1["index.ts"]
subgraph 2["tools"]
3["index.ts"]
4["generate-smrt-class.ts"]
5["introspect-project.ts"]
end
end
1-->3
3-->4
3-->5
