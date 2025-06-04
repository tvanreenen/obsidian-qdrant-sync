# Obsidian Qdrant Sync

Sync your Obsidian markdown notes with a [Qdrant](https://qdrant.tech/) vector database, using OpenAI embeddings for semantic search and retrieval.

---

## Features

- **Automatic Sync:** Watches for note creation, modification, and deletion, and syncs changes to Qdrant.
- **Semantic Chunking:** Splits notes into overlapping text chunks using a recursive character splitter, designed to respect markdown structure and semantics (not just fixed-size splits). This results in more meaningful embeddings and better search quality.
- **OpenAI Embeddings:** Uses OpenAI's API to generate vector embeddings for each chunk.
- **Batch Processing & Debouncing:** Efficiently batches requests to both OpenAI and Qdrant, and uses debouncing to avoid excessive API calls during rapid file changes, ensuring performance and reliability.
- **Customizable:** All parameters (API keys, batch sizes, chunking, etc.) are configurable via the plugin settings tab.
- **Manual Commands:** 
  - Reindex the entire vault
  - Index the active note

---

## Why Use a Vector Store?

Having your notes continuously indexed in a vector store like Qdrant means you can plug your knowledge base into a wide range of AI and search tools—semantic search, chatbots, retrieval-augmented generation (RAG), and more. Your vector store is always up to date as you work, unlocking powerful integrations and workflows across your toolchain.

---

## Unique ID Handling

Each note must have a unique ID in its frontmatter (e.g., `uuid`).  
**Tip:** For automatic and robust unique ID management, use my companion plugin:  
👉 [Obsidian Unique Identifiers](https://github.com/tvanreenen/obsidian-unique-identifiers)  
This plugin supports UUID, CUID, NanoID, ULID, and KSUID, and can bulk backfill or refresh IDs across your vault.  
It ensures every note is uniquely referenced for advanced workflows, integrations, and data management.

Example frontmatter:
```markdown
---
uuid: 123e4567-e89b-12d3-a456-426614174000
---
```
The field name is configurable in settings (`ID Field`).

---

## Semantic Chunking

Unlike simple fixed-size chunking, this plugin uses a recursive character splitter that is designed to respect markdown semantics—such as headings, lists, and paragraphs—when splitting your notes. This results in more natural, context-aware chunks, which improves the quality of embeddings and downstream search or retrieval tasks.

---

## Installation

1. Clone or download this repository.
2. Build the plugin (see [Obsidian sample plugin instructions](https://github.com/obsidianmd/obsidian-sample-plugin)).
3. Copy the build output to your Obsidian vault's `.obsidian/plugins/` directory.
4. Enable the plugin in Obsidian's settings.

---

## Configuration

Open the plugin settings in Obsidian and configure:

- **Qdrant API URL:** e.g., `http://localhost:6333`
- **Qdrant API Key:** (if required)
- **Collection Name:** Name of the Qdrant collection to sync to.
- **Vector Size:** Must match the output size of your embedding model (e.g., 1536 for `text-embedding-3-small`).
- **OpenAI API Key:** Your OpenAI API key.
- **OpenAI Model:** e.g., `text-embedding-3-small`
- **Batch Sizes:** For both Qdrant and OpenAI requests.
- **Chunking:** Max chunk size and overlap for splitting notes.
- **Debounce (ms):** How long to wait after a change before syncing.
- **ID Field:** Frontmatter field to use as the unique document ID (e.g., `uuid`).

> **Note:** As long as your Qdrant service is accessible and authenticatable, the plugin will automatically create the collection (if it doesn't exist) and index your notes for you. No manual setup required beyond providing the correct URL, API key, and collection name.

---

## Usage

- **Automatic Sync:** Notes are synced automatically on create, modify, or delete.
- **Manual Commands:**
  - **Reindex Entire Vault:** Command palette → "Reindex Entire Vault to Qdrant"
  - **Push Active Note:** Command palette → "Push Active Note to Qdrant"

---

## Troubleshooting

- Check the Obsidian console for error logs.
- Ensure your Qdrant instance is running and accessible.
- Make sure your OpenAI API key and model are correct.
- Vector size must match the embedding model output.

---

## Roadmap / TODO

- [ ] Expose "Prune Orphaned Points" command to clean up Qdrant.
- [ ] Add support for other embedding providers.
- [ ] More granular logging and error reporting.

---

## See Also

- [Obsidian Unique Identifiers](https://github.com/tvanreenen/obsidian-unique-identifiers):  
  Automatically assign and manage unique IDs in the frontmatter of your Obsidian notes with support for UUID, CUID, NanoID, ULID, and KSUID.

---

## License

MIT

---

**Contributions and issues welcome!**
