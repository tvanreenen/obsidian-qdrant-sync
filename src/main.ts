import { Plugin, TFile, PluginSettingTab, App, Setting, Notice } from "obsidian";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4 } from 'uuid';
import { sha256 } from 'js-sha256';

interface QdrantSyncSettings {
  qdrantUrl: string;
  collectionName: string;
  debounceMs: number;
  idField: string;
  maxChunkSize: number;
  chunkOverlap: number;
  openAiApiKey: string;
  openAiModel: string;
  qdrantBatchSize: number;
  vectorSize: number;
  qdrantApiKey: string;
  openAiBatchSize: number;
}

const DEFAULT_SETTINGS: QdrantSyncSettings = {
  qdrantUrl: "http://localhost:6333",
  collectionName: "obsidian-notes",
  debounceMs: 60000,
  idField: "uuid",
  maxChunkSize: 1000,
  chunkOverlap: 100,
  openAiApiKey: "",
  openAiModel: "text-embedding-3-small",
  qdrantBatchSize: 512,
  vectorSize: 1536,
  qdrantApiKey: "",
  openAiBatchSize: 100
};

export default class QdrantSyncPlugin extends Plugin {
  public settings: QdrantSyncSettings;
  private eventQueue: Map<string, { file: TFile, action: "upsert" | "delete" }> = new Map();
  private debounceTimer: number | null = null;
  public qdrant: QdrantClient;
  private isFlushing = false;

  public createQdrantClient() {
    return new QdrantClient({
      url: this.settings.qdrantUrl,
      apiKey: this.settings.qdrantApiKey,
    });
  }

  async onload() {
    await this.loadSettings();
    this.qdrant = this.createQdrantClient();
    this.addSettingTab(new QdrantSyncSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("modify", (file) => {
      console.log("[QdrantSync] File modified");
      if (file instanceof TFile) this.queueFile(file, "upsert");
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      console.log("[QdrantSync] File created");
      if (file instanceof TFile) this.queueFile(file, "upsert");
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      console.log("[QdrantSync] File deleted");
      if (file instanceof TFile) this.queueFile(file, "delete");
    }));

    this.addCommand({
      id: "qdrant-reindex-vault",
      name: "Reindex Entire Vault to Qdrant",
      callback: async () => {
        new Notice("QdrantSync reindexing vault...");
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
          this.queueFile(file, "upsert", false);
        }
        this.cancelDebounce();
        await this.flushQueue();
        new Notice("QdrantSync complete!");
      }
    });

    this.addCommand({
      id: "qdrant-index-active-note",
      name: "Push Active Note to Qdrant",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== "md") {
          new Notice("No active markdown file to index.");
          return;
        }
        const docId = this.getDocIdFromFileCache(activeFile);
        if (!docId) {
          new Notice("Active note does not have a valid ID.");
          return;
        }
        this.eventQueue.delete(activeFile.path);
        await this.processUpsertFiles([{ file: activeFile, docId }]);
        new Notice("Active note indexed to Qdrant.");
      }
    });

    /*
    this.addCommand({
      id: "qdrant-prune-orphaned-ids",
      name: "Prune Orphaned Points from Qdrant",
      callback: async () => {
        new Notice("Pruning orphaned Qdrant IDs...");
        // 1. Collect all docIds from the vault
        const vaultDocIds = new Set<string>();
        for (const file of this.app.vault.getMarkdownFiles()) {
          const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
          const docId = frontmatter[this.settings.idField];
          if (docId) vaultDocIds.add(docId);
        }
        // 2. Query Qdrant for all points (may need to page if large)
        const allQdrantPoints: any[] = [];
        let offset = 0;
        const limit = 1000;
        while (true) {
          const result = await this.qdrant.scroll(this.settings.collectionName, {
            limit,
            offset,
            with_payload: true,
            with_vector: false
          });
          if (result.points.length === 0) break;
          allQdrantPoints.push(...result.points);
          if (result.points.length < limit) break;
          offset += result.points.length;
        }
        // 3. Find points whose docId is not in the vault
        const orphanedDocIds: string[] = [];
        for (const point of allQdrantPoints) {
          const docId = point.payload?.frontmatter?.[this.settings.idField];
          if (docId && !vaultDocIds.has(docId)) {
            orphanedDocIds.push(docId);
          }
        }
        // 4. Delete orphaned points from Qdrant
        if (orphanedDocIds.length > 0) {
          await this.batchDeleteByDocIds(orphanedDocIds);
          new Notice(`Pruned ${orphanedDocIds.length} orphaned Qdrant IDs.`);
        } else {
          new Notice("No orphaned Qdrant IDs found.");
        }
      }
    });
    */
  }

  onunload() {
    this.cancelDebounce();
    this.flushQueue();
  }

  private cancelDebounce() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private queueFile(file: TFile, action: "upsert" | "delete", debounce: boolean = true) {
    if (file.extension !== "md") return;
    const docId = this.getDocIdFromFileCache(file);
    if (!docId) return;
    this.eventQueue.set(docId, { file, action });
    if (debounce) {
      this.cancelDebounce();
      this.debounceTimer = window.setTimeout(() => {
        this.flushQueue();
        this.debounceTimer = null;
      }, this.settings.debounceMs);
    }
  }

  private async flushQueue() {
    if (this.isFlushing) return;
    try {
      this.isFlushing = true;
      const { upsertItems, deleteItems } = this.getFilesByAction();
      await this.processDeleteFiles(deleteItems);
      await this.processUpsertFiles(upsertItems);
    } catch (e) {
      new Notice("QdrantSync failed. See console for details.");
      console.error("[QdrantSync] Error when trying to flush event queue:", e);
    } finally {
      this.isFlushing = false;
    }
  }

  private getFilesByAction() {
    const upsertItems: { file: TFile, docId: string }[] = [];
    const deleteItems: { file: TFile, docId: string }[] = [];
    for (const [docId, item] of this.eventQueue.entries()) {
      if (item.action === "delete") deleteItems.push({ file: item.file, docId });
      else upsertItems.push({ file: item.file, docId });
    }
    return { upsertItems, deleteItems };
  }

  private getDocIdFromFileCache(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    return frontmatter[this.settings.idField] || null;
  }

  private async processDeleteFiles(deleteItems: { file: TFile, docId: string }[]) {
    if (deleteItems.length === 0) return;
    const batchSize = this.settings.qdrantBatchSize;
    for (let i = 0; i < deleteItems.length; i += batchSize) {
      const batch = deleteItems.slice(i, i + batchSize);
      const batchDocIds: string[] = batch.map(item => item.docId);
      if (batchDocIds.length > 0) {
        await this.batchDeleteByDocIds(batchDocIds);
        for (const docId of batchDocIds) {
          this.eventQueue.delete(docId);
        }
      }
    }
  }

  private async processUpsertFiles(upsertItems: { file: TFile, docId: string }[]) {
    if (upsertItems.length === 0) return;
    const batchSize = this.settings.qdrantBatchSize;
    for (let i = 0; i < upsertItems.length; i += batchSize) {
      const batch = upsertItems.slice(i, i + batchSize);
      let allTextsToEmbed: string[] = [];
      let embeddingToPointMap: { 
        file: TFile, 
        chunkIndex: number, 
        text: string, 
        frontmatter: any, 
        docId: string, 
      }[] = [];
      const batchDocIds: string[] = [];
      for (const { file, docId } of batch) {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const content = await this.getFileContentWithoutFrontmatter(file);
        if (!content.length) continue;
        batchDocIds.push(docId);
        const chunks = await this.chunkWithSplitter(content);
        for (let i = 0; i < chunks.length; i++) {
          allTextsToEmbed.push(chunks[i]);
          embeddingToPointMap.push({ file, chunkIndex: i, text: chunks[i], frontmatter, docId });
        }
      }
      console.log("[QdrantSync] Number of files to vectorize and store:", batchDocIds.length);
      if (batchDocIds.length > 0) {
        await this.batchDeleteByDocIds(batchDocIds);
      }
      let allEmbeddings: number[][] = [];
      allEmbeddings = await this.batchEmbedTexts(allTextsToEmbed);
      await this.batchUpsertPoints(allEmbeddings, embeddingToPointMap);
      for (const docId of batchDocIds) {
        this.eventQueue.delete(docId);
      }
    }
  }

  private async batchDeleteByDocIds(docIds: string[]) {
    if (docIds.length === 0) return;
    const shouldClauses = docIds.map(docId => ({
      key: `frontmatter.${this.settings.idField}`,
      match: { value: docId }
    }));
    await this.qdrant.delete(this.settings.collectionName, {
      filter: { should: shouldClauses }
    });
  }

  private async sendPointsToQdrant(points: any[]): Promise<void> {
    await this.qdrant.upsert(this.settings.collectionName, { points });
  }

  private async batchUpsertPoints(
    allEmbeddings: number[][], 
    embeddingToPointMap: { 
      file: TFile, 
      chunkIndex: number, 
      text: string, 
      frontmatter: any, 
      docId: string, 
    }[]
  ) {
    for (let i = 0; i < allEmbeddings.length; i += this.settings.qdrantBatchSize) {
      const batchEmbeddings = allEmbeddings.slice(i, i + this.settings.qdrantBatchSize);
      const batchMap = embeddingToPointMap.slice(i, i + this.settings.qdrantBatchSize);
      const batchPoints = batchEmbeddings.map((embedding, idx) => {
        const point = batchMap[idx];
        return {
          id: uuidv4(),
          vector: embedding,
          payload: {
            frontmatter: point.frontmatter,
            chunk_text: point.text,
            chunk_hash: sha256(point.text),
            chunk_index: point.chunkIndex,
            created_at: new Date().toISOString(),
          }
        };
      });
      await this.sendPointsToQdrant(batchPoints);
    }
  }

  private async getFileContentWithoutFrontmatter(file: TFile) {
    const rawContent = await this.app.vault.read(file);
    return this.stripFrontmatter(rawContent);
  }

  private async sendOpenAIEmbeddingRequest(batch: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.settings.openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.settings.openAiModel,
        input: batch
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    const result = await response.json();
    if (!result.data) {
      throw new Error(`OpenAI API returned no data: ${JSON.stringify(result)}`);
    }
    return result.data.map((item: any) => item.embedding);
  }

  private async batchEmbedTexts(texts: string[]): Promise<number[][]> {
    const MAX_BATCH_SIZE = this.settings.openAiBatchSize;
    let allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const batchEmbeddings = await this.sendOpenAIEmbeddingRequest(batch);
      allEmbeddings.push(...batchEmbeddings);
    }
    return allEmbeddings;
  }

  private stripFrontmatter(content: string): string {
    if (content.startsWith('---')) {
      const end = content.indexOf('\n---', 3);
      if (end !== -1) {
        return content.slice(end + 4); // skip past the closing '---\n'
      }
    }
    return content;
  }

  private async chunkWithSplitter(content: string): Promise<string[]> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.settings.maxChunkSize,
      chunkOverlap: this.settings.chunkOverlap,
    });

    const docs = await splitter.createDocuments([content]);
    return docs.map(doc => doc.pageContent);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class QdrantSyncSettingTab extends PluginSettingTab {
  plugin: QdrantSyncPlugin;

  constructor(app: App, plugin: QdrantSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h1", { text: "Qdrant Sync" });

    let debounceMsInput: HTMLInputElement;
    let idFieldInput: HTMLInputElement;
    let maxChunkSizeInput: HTMLInputElement;
    let chunkOverlapInput: HTMLInputElement;
    let openAiApiKeyInput: HTMLInputElement;
    let openAiModelInput: HTMLInputElement;
    let openAiBatchSizeInput: HTMLInputElement;
    let qdrantUrlInput: HTMLInputElement;
    let qdrantApiKeyInput: HTMLInputElement;
    let collectionNameInput: HTMLInputElement;
    let vectorSizeInput: HTMLInputElement;
    let qdrantBatchSizeInput: HTMLInputElement;

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Milliseconds to wait before syncing after a change")
      .addText(text => {
        text.setValue(this.plugin.settings.debounceMs.toString());
        debounceMsInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("ID Field")
      .setDesc("Frontmatter field to use as unique document ID (e.g., uuid)")
      .addText(text => {
        text.setValue(this.plugin.settings.idField);
        idFieldInput = text.inputEl;
      });
    
    new Setting(containerEl)
			.setName('Recursive Character Text Splitter')
			.setHeading();
    new Setting(containerEl)
      .setName("Max Chunk Size")
      .setDesc("Maximum characters per chunk")
      .addText(text => {
        text.setValue(this.plugin.settings.maxChunkSize.toString());
        maxChunkSizeInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("Chunk Overlap")
      .setDesc("Characters of overlap between chunks")
      .addText(text => {
        text.setValue(this.plugin.settings.chunkOverlap.toString());
        chunkOverlapInput = text.inputEl;
      });

    new Setting(containerEl)
			.setName('OpenAI')
			.setHeading();
    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("API key for OpenAI embeddings")
      .addText(text => {
        text.setValue(this.plugin.settings.openAiApiKey);
        openAiApiKeyInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("OpenAI Model")
      .setDesc("OpenAI embedding model name (e.g., text-embedding-3-small)")
      .addText(text => {
        text.setValue(this.plugin.settings.openAiModel);
        openAiModelInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("OpenAI Batch Size")
      .setDesc("Number of texts to send per batch to OpenAI for embedding")
      .addText(text => {
        text.setValue(this.plugin.settings.openAiBatchSize.toString());
        openAiBatchSizeInput = text.inputEl;
      });

    new Setting(containerEl)
			.setName('Qdrant')
			.setHeading();
    new Setting(containerEl)
      .setName("Qdrant API URL")
      .setDesc("e.g., http://localhost:6333")
      .addText(text => {
        text.setValue(this.plugin.settings.qdrantUrl);
        qdrantUrlInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("Qdrant API Key")
      .setDesc("API key for Qdrant (if required)")
      .addText(text => {
        text.setValue(this.plugin.settings.qdrantApiKey);
        qdrantApiKeyInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("Collection Name")
      .setDesc("Qdrant collection to sync notes to")
      .addText(text => {
        text.setValue(this.plugin.settings.collectionName);
        collectionNameInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("Vector Size")
      .setDesc("Dimensionality of vectors (must match embedding model output)")
      .addText(text => {
        text.setValue(this.plugin.settings.vectorSize.toString());
        vectorSizeInput = text.inputEl;
      });
    new Setting(containerEl)
      .setName("Qdrant Batch Size")
      .setDesc("Number of points to send per batch to Qdrant")
      .addText(text => {
        text.setValue(this.plugin.settings.qdrantBatchSize.toString());
        qdrantBatchSizeInput = text.inputEl;
      });

    const saveBtn = containerEl.createEl("button", { text: "Save Settings", cls: "mod-cta" });
    saveBtn.onclick = async () => {
      this.plugin.settings.debounceMs = parseInt(debounceMsInput.value);
      this.plugin.settings.idField = idFieldInput.value;
      this.plugin.settings.maxChunkSize = parseInt(maxChunkSizeInput.value);
      this.plugin.settings.chunkOverlap = parseInt(chunkOverlapInput.value);
      this.plugin.settings.openAiApiKey = openAiApiKeyInput.value;
      this.plugin.settings.openAiModel = openAiModelInput.value;
      this.plugin.settings.openAiBatchSize = parseInt(openAiBatchSizeInput.value);
      this.plugin.settings.qdrantUrl = qdrantUrlInput.value;
      this.plugin.settings.qdrantApiKey = qdrantApiKeyInput.value;
      this.plugin.settings.collectionName = collectionNameInput.value;
      this.plugin.settings.vectorSize = parseInt(vectorSizeInput.value);
      this.plugin.settings.qdrantBatchSize = parseInt(qdrantBatchSizeInput.value);
      await this.plugin.saveSettings();
      // Re-create Qdrant client in case the URL or API key changed
      this.plugin.qdrant = this.plugin.createQdrantClient();

      try {
        const response = await this.plugin.qdrant.getCollections();
        const collectionNames = response.collections.map((collection: { name: string }) => collection.name);
        if (!collectionNames.includes(this.plugin.settings.collectionName)) {
          await this.plugin.qdrant.createCollection(this.plugin.settings.collectionName, {
            vectors: {
              size: this.plugin.settings.vectorSize,
              distance: "Cosine"
            }
          });
        }
      } catch (e) {
        new Notice("QdrantSync failed. See console for details.");
        console.error('[QdrantSync] Error checking Qdrant collection:', e);
      }

      new Notice("QdrantSync settings saved!");
    };
  }
}
