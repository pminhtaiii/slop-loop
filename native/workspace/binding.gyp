{
  "targets": [
    {
      "target_name": "workspace_boundary",
      "sources": ["addon.cc"],
      "conditions": [
        ["OS=='linux'", { "sources": ["linux.cc"] }],
        ["OS=='win'", { "sources": ["windows.cc"] }]
      ],
      "defines": ["NAPI_VERSION=8"]
    }
  ]
}
