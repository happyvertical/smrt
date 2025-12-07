flowchart LR

subgraph 0["src"]
subgraph 1["collections"]
2["EmailAccountCollection.ts"]
5["EmailCollection.ts"]
7["EmailAttachmentCollection.ts"]
A["EmailFolderCollection.ts"]
end
subgraph 3["models"]
4["EmailAccount.ts"]
6["Email.ts"]
8["EmailAttachment.ts"]
B["EmailFolder.ts"]
end
9["types.ts"]
C["index.ts"]
subgraph D["manifest"]
E["test-manifest-stub.ts"]
end
end
2-->4
2-->9
4-->5
4-->A
4-->9
4-->6
4-->B
5-->6
5-->9
6-->2
6-->7
6-->5
6-->A
6-->9
7-->8
8-->5
8-->9
A-->B
A-->9
B-->2
B-->5
B-->9
C-->2
C-->7
C-->5
C-->A
C-->6
C-->4
C-->8
C-->B
C-->9
