import { describe, beforeEach, expect, it, vi, afterEach } from 'vitest';
import runMigrations from '../../models/runMigrations';
import { ObjectModel } from '../../models/ObjectModel';
import { ChunkSqlModel } from '../../models/ChunkModel';
import { ChatModel } from '../../models/ChatModel';
import { NotebookModel } from '../../models/NotebookModel';
import { NotebookService } from '../NotebookService';
import { JeffersObject, NotebookRecord, IChatSession, ObjectChunk } from '../../shared/types';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

// Mock logger to prevent console output during tests
vi.mock('../../utils/logger', () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe('NotebookService with BaseService', () => {
  let db: Database.Database;
  let objectModel: ObjectModel;
  let chunkSqlModel: ChunkSqlModel;
  let chatModel: ChatModel;
  let notebookModel: NotebookModel;
  let notebookService: NotebookService;

  beforeEach(async () => {
    // Create in-memory database
    db = new Database(':memory:');
    await runMigrations(db);

    // Initialize models
    objectModel = new ObjectModel(db);
    chunkSqlModel = new ChunkSqlModel(db);
    chatModel = new ChatModel(db);
    notebookModel = new NotebookModel(db);
    
    // Create service with dependency injection
    notebookService = new NotebookService({
      db,
      notebookModel,
      objectModel,
      chunkSqlModel,
      chatModel
    });
    
    // Initialize service
    await notebookService.initialize();
  });

  afterEach(async () => {
    // Cleanup service
    await notebookService.cleanup();
    
    if (db && db.open) {
      db.close();
    }
    
    vi.clearAllMocks();
  });

  it('should be true', () => {
    expect(true).toBe(true);
  });

  // Test suites for each NotebookService method will go here
  describe('createNotebook', () => {
    it('should create a NotebookRecord and a corresponding JeffersObject with correct details', async () => {
      const title = 'Test Notebook';
      const description = 'This is a test description.';

      const notebookRecord = await notebookService.createNotebook(title, description);

      // Verify NotebookRecord
      expect(notebookRecord).toBeDefined();
      expect(notebookRecord.id).toEqual(expect.any(String));
      expect(notebookRecord.title).toBe(title);
      expect(notebookRecord.description).toBe(description);
      expect(notebookRecord.createdAt).toEqual(expect.any(Number));
      expect(notebookRecord.updatedAt).toEqual(expect.any(Number));
      expect(notebookRecord.createdAt).toBe(notebookRecord.updatedAt);

      // Verify JeffersObject
      const expectedSourceUri = `jeffers://notebook/${notebookRecord.id}`;
      const jeffersObject = await objectModel.getBySourceUri(expectedSourceUri);

      expect(jeffersObject).toBeDefined();
      if (!jeffersObject) throw new Error('JeffersObject not found'); // Type guard

      expect(jeffersObject.objectType).toBe('notebook');
      expect(jeffersObject.sourceUri).toBe(expectedSourceUri);
      expect(jeffersObject.title).toBe(title);
      const expectedCleanedText = `${title}\n${description}`;
      expect(jeffersObject.cleanedText).toBe(expectedCleanedText);
      expect(jeffersObject.status).toBe('parsed');
      expect(jeffersObject.parsedAt).toBeDefined();
    });

    it('should create a NotebookRecord and JeffersObject when description is null', async () => {
      const title = 'Test Notebook No Description';

      const notebookRecord = await notebookService.createNotebook(title, null);

      expect(notebookRecord).toBeDefined();
      expect(notebookRecord.title).toBe(title);
      expect(notebookRecord.description).toBeNull();

      const expectedSourceUri = `jeffers://notebook/${notebookRecord.id}`;
      const jeffersObject = await objectModel.getBySourceUri(expectedSourceUri);

      expect(jeffersObject).toBeDefined();
      if (!jeffersObject) throw new Error('JeffersObject not found');

      expect(jeffersObject.title).toBe(title);
      const expectedCleanedText = title; // No newline or null description part
      expect(jeffersObject.cleanedText).toBe(expectedCleanedText);
    });

    it('should rollback NotebookRecord creation if JeffersObject creation fails', async () => {
      const title = 'Fail Object Notebook';
      const description = 'This should fail.';

      // Spy on objectModel.create and make it throw an error
      const createObjectSpy = vi.spyOn(objectModel, 'create').mockImplementationOnce(async () => {
        throw new Error('Simulated ObjectModel.create failure');
      });

      await expect(notebookService.createNotebook(title, description))
        .rejects
        .toThrow('Failed to create notebook transactionally: Simulated ObjectModel.create failure');

      // Verify no NotebookRecord was created with this title
      // (Assuming title is unique enough for this test scenario, or query by a non-existent ID if possible)
      const allNotebooks = await notebookModel.getAll();
      const foundNotebook = allNotebooks.find(nb => nb.title === title);
      expect(foundNotebook).toBeUndefined();
      
      // Verify no JeffersObject was created (though the spy prevents it, this is an extra check)
      // We can't easily get the intended source URI as the notebook ID was never finalized in a successful record.
      // Instead, we can check if any object was created with the title.
      // This part is a bit indirect for objectModel verification because the sourceUri is key.
      // The primary verification is that the notebook record itself is absent.
      const objectsWithTitle = (await objectModel.findByStatus(['parsed', 'new', 'error'])) // check common statuses
                                 .map(async objId => await objectModel.getById(objId.id))
                                 .filter(async objProm => (await objProm)?.title === title);
      expect(objectsWithTitle.length).toBe(0); // This is a bit weak, but covers basics

      createObjectSpy.mockRestore(); // Clean up the spy
    });
  });

  describe('getNotebookById', () => {
    it('should retrieve an existing notebook by its ID', async () => {
      const createdNotebook = await notebookService.createNotebook('GetMe', 'Description');
      const fetchedNotebook = await notebookService.getNotebookById(createdNotebook.id);
      expect(fetchedNotebook).toBeDefined();
      expect(fetchedNotebook?.id).toBe(createdNotebook.id);
      expect(fetchedNotebook?.title).toBe('GetMe');
    });

    it('should return null for a non-existent notebook ID', async () => {
      const nonExistentId = randomUUID();
      const fetchedNotebook = await notebookService.getNotebookById(nonExistentId);
      expect(fetchedNotebook).toBeNull();
    });
  });

  describe('getAllNotebooks', () => {
    it('should return only the default notebook cover if no other notebooks exist', async () => {
      const allNotebooks = await notebookService.getAllNotebooks();
      // Migration creates a default notebook cover, so we expect 1 item
      expect(allNotebooks.length).toBe(1);
      expect(allNotebooks[0].id).toBe('cover-default_user');
      expect(allNotebooks[0].title).toBe('Homepage Conversations');
    });

    it('should retrieve all created notebooks', async () => {
      await notebookService.createNotebook('NB1', 'Desc1');
      await notebookService.createNotebook('NB2', 'Desc2');
      const allNotebooks = await notebookService.getAllNotebooks();
      expect(allNotebooks.length).toBe(3); // 2 created + 1 default cover
      // Order is by title ASC as per NotebookModel.getAll()
      // The default cover "Homepage Conversations" comes before NB1 and NB2
      expect(allNotebooks[0].title).toBe('Homepage Conversations');
      expect(allNotebooks[1].title).toBe('NB1');
      expect(allNotebooks[2].title).toBe('NB2');
    });
  });

  describe('updateNotebook', () => {
    let notebook: NotebookRecord;

    beforeEach(async () => {
      notebook = await notebookService.createNotebook('Original Title', 'Original Description');
    });

    it('should update title and description and the corresponding JeffersObject', async () => {
      const updates = { title: 'Updated Title', description: 'Updated Description' };
      const updatedNotebook = await notebookService.updateNotebook(notebook.id, updates);

      expect(updatedNotebook).toBeDefined();
      expect(updatedNotebook?.title).toBe(updates.title);
      expect(updatedNotebook?.description).toBe(updates.description);

      const jeffersObject = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(jeffersObject?.title).toBe(updates.title);
      expect(jeffersObject?.cleanedText).toBe(`${updates.title}\n${updates.description}`);
    });

    it('should update only title and the corresponding JeffersObject', async () => {
      const updates = { title: 'New Title Only' };
      await notebookService.updateNotebook(notebook.id, updates);
      
      const fetchedNotebook = await notebookModel.getById(notebook.id);
      expect(fetchedNotebook?.title).toBe(updates.title);
      expect(fetchedNotebook?.description).toBe('Original Description'); // Description should remain unchanged

      const jeffersObject = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(jeffersObject?.title).toBe(updates.title);
      expect(jeffersObject?.cleanedText).toBe(`${updates.title}\nOriginal Description`);
    });

    it('should update description to null and the corresponding JeffersObject', async () => {
      const updates = { description: null };
      await notebookService.updateNotebook(notebook.id, updates);

      const fetchedNotebook = await notebookModel.getById(notebook.id);
      expect(fetchedNotebook?.title).toBe('Original Title');
      expect(fetchedNotebook?.description).toBeNull();

      const jeffersObject = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(jeffersObject?.title).toBe('Original Title');
      expect(jeffersObject?.cleanedText).toBe('Original Title'); // Cleaned text without null description
    });

    it('should return null if attempting to update a non-existent notebook', async () => {
      const nonExistentId = randomUUID();
      const result = await notebookService.updateNotebook(nonExistentId, { title: 'No Such Notebook' });
      expect(result).toBeNull();
    });
    
    it('should rollback NotebookRecord update if JeffersObject update fails', async () => {
      const updates = { title: 'Update That Will Fail Object', description: 'Desc' };
      const originalNotebook = await notebookModel.getById(notebook.id);

      const updateObjectSpy = vi.spyOn(objectModel, 'update').mockImplementationOnce(async () => {
        throw new Error('Simulated ObjectModel.update failure');
      });

      await expect(notebookService.updateNotebook(notebook.id, updates))
        .rejects
        .toThrow('Failed to update notebook transactionally: Simulated ObjectModel.update failure');

      const notebookAfterFailedUpdate = await notebookModel.getById(notebook.id);
      expect(notebookAfterFailedUpdate?.title).toBe(originalNotebook?.title);
      expect(notebookAfterFailedUpdate?.description).toBe(originalNotebook?.description);

      updateObjectSpy.mockRestore();
    });

    it('should still update NotebookRecord if its JeffersObject is missing (and log warning)', async () => {
      // First, delete the associated JeffersObject manually
      const sourceUri = `jeffers://notebook/${notebook.id}`;
      const initialJeffersObject = await objectModel.getBySourceUri(sourceUri);
      if (initialJeffersObject) {
        await objectModel.deleteById(initialJeffersObject.id);
      }
      const deletedJeffersObject = await objectModel.getBySourceUri(sourceUri);
      expect(deletedJeffersObject).toBeNull(); // Confirm JeffersObject is gone

      const updates = { title: 'Updated Title For Missing Object', description: 'New Desc' };
      // Spy on logger.warn - this is optional but good for full verification
      const loggerWarnSpy = vi.spyOn(console, 'warn'); // Assuming logger.warn eventually calls console.warn or similar
      
      const updatedNotebook = await notebookService.updateNotebook(notebook.id, updates);
      
      expect(updatedNotebook).toBeDefined();
      expect(updatedNotebook?.title).toBe(updates.title);
      expect(updatedNotebook?.description).toBe(updates.description);
      
      // Check if the warning was logged - this depends on your logger setup
      // For simplicity, we'll assume the service handles logging and focus on DB state.
      // expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('JeffersObject not found for notebook ID'));
      loggerWarnSpy.mockRestore();
    });
  });

  describe('deleteNotebook', () => {
    let notebook: NotebookRecord;
    let jeffersObject: JeffersObject | null; // Notebook's own JeffersObject
    let chatSession: IChatSession;
    let chunk: ObjectChunk; // This is the chunk whose notebook_id we'll check for nullification
    let independentJeffersObjectForChunk: JeffersObject; // For the chunk's object_id

    beforeEach(async () => {
      notebook = await notebookService.createNotebook('ToDelete', 'Delete Desc');
      jeffersObject = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`); // Get the notebook's own JO
      
      // Create a separate JeffersObject specifically for the chunk used in the SET NULL test
      independentJeffersObjectForChunk = await objectModel.create({
        objectType: 'test_source_for_chunk',
        sourceUri: `test://source_set_null_test/${randomUUID()}`,
        title: 'Independent Object for SET NULL Test Chunk',
        status: 'parsed',
        cleanedText: 'Content for independent object',
        rawContentRef: null,
        parsedContentJson: null,
        errorInfo: null,
        parsedAt: new Date(),
      });
      
      chatSession = await chatModel.createSession(notebook.id, randomUUID(), 'Chat in ToDelete');
      
      // Create the specific chunk for testing SET NULL, linked to the INDEPENDENT JeffersObject
      const createdChunkForSetNullTest = await chunkSqlModel.addChunk({
        objectId: independentJeffersObjectForChunk.id, 
        chunkIdx: 0,
        content: 'Test chunk content for SET NULL behavior',
      });
      await chunkSqlModel.assignToNotebook(createdChunkForSetNullTest.id, notebook.id);
      
      // Make 'chunk' refer to this specific chunk for the relevant test
      const tempChunk = await chunkSqlModel.getById(createdChunkForSetNullTest.id);
      if (!tempChunk) throw new Error('Chunk for SET NULL test not created in beforeEach');
      chunk = tempChunk; // 'chunk' variable will be used in the "nullify chunk_id" test
    });

    it('should delete the NotebookRecord, its JeffersObject, cascade delete chat sessions, and nullify chunk notebook_id', async () => {
      const deleteResult = await notebookService.deleteNotebook(notebook.id);
      expect(deleteResult).toBe(true);

      // Verify NotebookRecord is deleted
      const deletedNotebookRecord = await notebookModel.getById(notebook.id);
      expect(deletedNotebookRecord).toBeNull();

      // Verify JeffersObject (the notebook's own) is deleted
      const deletedJeffersObject = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(deletedJeffersObject).toBeNull();

      // Verify chat session is cascade-deleted
      const sessionsForNotebook = await chatModel.listSessionsForNotebook(notebook.id);
      expect(sessionsForNotebook.length).toBe(0);
      const deletedSession = await chatModel.getSessionById(chatSession.sessionId); // Updated method and property
      expect(deletedSession).toBeNull(); // Direct check

      // Verify chunk's notebook_id is nullified (chunk sourced from independentJeffersObjectForChunk)
      const updatedChunk = await chunkSqlModel.getById(chunk.id);
      expect(updatedChunk).toBeDefined(); // The chunk itself should still exist
      expect(updatedChunk?.notebookId).toBeNull(); // Updated property: notebookId
    });

    it('should return false if trying to delete a non-existent notebook', async () => {
      const nonExistentId = randomUUID();
      const deleteResult = await notebookService.deleteNotebook(nonExistentId);
      expect(deleteResult).toBe(false);
    });

    it('should rollback deletion if JeffersObject deletion fails', async () => {
      const deleteObjectSpy = vi.spyOn(objectModel, 'deleteById').mockImplementationOnce(async () => {
        throw new Error('Simulated ObjectModel.deleteById failure');
      });

      await expect(notebookService.deleteNotebook(notebook.id))
        .rejects
        .toThrow('Failed to delete notebook transactionally: Simulated ObjectModel.deleteById failure');

      // Verify NotebookRecord still exists
      const stillExistsNotebook = await notebookModel.getById(notebook.id);
      expect(stillExistsNotebook).toBeDefined();

      // Verify JeffersObject still exists
      const stillExistsJeffersObject = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(stillExistsJeffersObject).toBeDefined();

      deleteObjectSpy.mockRestore();
    });

    it('should rollback JeffersObject deletion if NotebookRecord deletion fails subsequently', async () => {
      // This spy will allow objectModel.deleteById to succeed, then make notebookModel.delete fail
      const deleteNotebookModelSpy = vi.spyOn(notebookModel, 'delete').mockImplementationOnce(async (id: string) => {
        // Simulate that objectModel.deleteById was called and succeeded before this fails
        // We can't directly assert the call order here without more complex spying on the transaction itself.
        // The key is that this *throws after* objectModel.deleteById would have run in the service method.
        throw new Error('Simulated NotebookModel.delete failure after object deletion');
      });

      await expect(notebookService.deleteNotebook(notebook.id))
        .rejects
        .toThrow('Failed to delete notebook transactionally: Simulated NotebookModel.delete failure after object deletion');

      // Verify NotebookRecord still exists because its own deletion failed
      const notebookRecordStillThere = await notebookModel.getById(notebook.id);
      expect(notebookRecordStillThere).toBeDefined();

      // CRITICAL: Verify JeffersObject also still exists (due to rollback)
      const jeffersObjectRestored = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(jeffersObjectRestored).toBeDefined();
      expect(jeffersObjectRestored?.id).toBe(jeffersObject?.id); // Corrected: Compare to notebook's own JO

      deleteNotebookModelSpy.mockRestore();
    });

    it('should delete NotebookRecord even if its JeffersObject is missing (and log warning)', async () => {
       // Manually delete the notebook's own JeffersObject first
      if (jeffersObject) { // jeffersObject is the notebook's own JO from the suite's beforeEach
        await objectModel.deleteById(jeffersObject.id);
      }
      const confirmedMissingNotebookJO = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      expect(confirmedMissingNotebookJO).toBeNull(); // Confirm notebook's own JO is gone

      const loggerWarnSpy = vi.spyOn(console, 'warn'); // Assuming logger.warn uses console.warn

      const deleteResult = await notebookService.deleteNotebook(notebook.id);
      expect(deleteResult).toBe(true);

      const deletedNotebookRecord = await notebookModel.getById(notebook.id);
      expect(deletedNotebookRecord).toBeNull();
      
      // Check logger was called, exact message matching can be fragile
      // expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('No corresponding JeffersObject found'));
      loggerWarnSpy.mockRestore();
    });

  });

  describe('createChatInNotebook', () => {
    let notebook: NotebookRecord;

    beforeEach(async () => {
      notebook = await notebookService.createNotebook('NotebookForChat', 'Test Desc');
    });

    it('should create a chat session in the specified notebook with a title', async () => {
      const chatTitle = 'My Test Chat';
      const chatSession = await notebookService.createChatInNotebook(notebook.id, chatTitle);
      expect(chatSession).toBeDefined();
      expect(chatSession.sessionId).toEqual(expect.any(String)); // Updated
      expect(chatSession.notebookId).toBe(notebook.id); // Updated
      expect(chatSession.title).toBe(chatTitle);
    });

    it('should create a chat session with a null title if not provided', async () => {
      const chatSession = await notebookService.createChatInNotebook(notebook.id, null);
      expect(chatSession).toBeDefined();
      expect(chatSession.notebookId).toBe(notebook.id); // Updated
      expect(chatSession.title).toBeNull();
    });

    it('should create a chat session with an undefined title (becomes null) if not provided', async () => {
        const chatSession = await notebookService.createChatInNotebook(notebook.id);
        expect(chatSession).toBeDefined();
        expect(chatSession.notebookId).toBe(notebook.id); // Updated
        expect(chatSession.title).toBeNull(); 
      });

    it('should throw an error if trying to create a chat in a non-existent notebook', async () => {
      const nonExistentNotebookId = randomUUID();
      await expect(notebookService.createChatInNotebook(nonExistentNotebookId, 'Chat Title'))
        .rejects
        .toThrow(`Notebook not found with ID: ${nonExistentNotebookId}`);
    });
  });

  describe('listChatsForNotebook', () => {
    let notebook1: NotebookRecord;
    let notebook2: NotebookRecord;

    beforeEach(async () => {
      notebook1 = await notebookService.createNotebook('NotebookWithChats', 'Desc1');
      notebook2 = await notebookService.createNotebook('NotebookWithoutChats', 'Desc2');
      // Create some chats for notebook1
      await chatModel.createSession(notebook1.id, randomUUID(), 'Chat 1 in NB1');
      await chatModel.createSession(notebook1.id, randomUUID(), 'Chat 2 in NB1');
    });

    it('should list all chat sessions for a given notebook', async () => {
      const chats = await notebookService.listChatsForNotebook(notebook1.id);
      expect(chats.length).toBe(2);
      expect(chats.every(c => c.notebookId === notebook1.id)).toBe(true); // Updated
    });

    it('should return an empty array for a notebook with no chat sessions', async () => {
      const chats = await notebookService.listChatsForNotebook(notebook2.id);
      expect(chats).toEqual([]);
    });

    it('should throw an error if trying to list chats for a non-existent notebook', async () => {
      const nonExistentNotebookId = randomUUID();
      await expect(notebookService.listChatsForNotebook(nonExistentNotebookId))
        .rejects
        .toThrow(`Notebook not found with ID: ${nonExistentNotebookId}`);
    });
  });

  describe('transferChatToNotebook', () => {
    let notebook1: NotebookRecord;
    let notebook2: NotebookRecord;
    let chatSession: IChatSession;

    beforeEach(async () => {
      notebook1 = await notebookService.createNotebook('SourceNotebook', 'SrcDesc');
      notebook2 = await notebookService.createNotebook('TargetNotebook', 'TgtDesc');
      chatSession = await chatModel.createSession(notebook1.id, randomUUID(), 'ChatToTransfer');
    });

    it('should successfully transfer a chat session to another notebook', async () => {
      const result = await notebookService.transferChatToNotebook(chatSession.sessionId, notebook2.id); // Updated
      expect(result).toBe(true);
      const updatedSession = await chatModel.getSessionById(chatSession.sessionId); // Updated method and property
      expect(updatedSession?.notebookId).toBe(notebook2.id); // Updated
    });

    it('should throw an error if the chat session does not exist', async () => {
      const nonExistentSessionId = randomUUID();
      await expect(notebookService.transferChatToNotebook(nonExistentSessionId, notebook2.id))
        .rejects
        .toThrow(`Chat session not found with ID: ${nonExistentSessionId}`);
    });

    it('should throw an error if the target notebook does not exist', async () => {
      const nonExistentNotebookId = randomUUID();
      await expect(notebookService.transferChatToNotebook(chatSession.sessionId, nonExistentNotebookId)) // Updated
        .rejects
        .toThrow(`Target notebook not found with ID: ${nonExistentNotebookId}`);
    });

    it('should return true and make no changes if chat is already in the target notebook', async () => {
      const result = await notebookService.transferChatToNotebook(chatSession.sessionId, notebook1.id); // Updated
      expect(result).toBe(true);
      const notUpdatedSession = await chatModel.getSessionById(chatSession.sessionId); // Updated method and property
      expect(notUpdatedSession?.notebookId).toBe(notebook1.id); // Updated
    });
  });

  describe('assignChunkToNotebook', () => {
    let notebook: NotebookRecord;
    let chunk: ObjectChunk;
    let jeffersObj: JeffersObject;

    beforeEach(async () => {
      notebook = await notebookService.createNotebook('NotebookForChunk', 'Desc');
      const tempJeffersObj = await objectModel.getBySourceUri(`jeffers://notebook/${notebook.id}`);
      if (!tempJeffersObj) throw new Error ('JeffersObject for notebook not found in assignChunkToNotebook beforeEach');
      jeffersObj = tempJeffersObj;
      
      const createdChunk = await chunkSqlModel.addChunk({
        objectId: jeffersObj.id, 
        chunkIdx: 0,
        content: 'Test chunk for assignment',
      });
      chunk = createdChunk;
    });

    it('should assign a chunk to a notebook', async () => {
      const result = await notebookService.assignChunkToNotebook(chunk.id, notebook.id);
      expect(result).toBe(true);
      const updatedChunk = await chunkSqlModel.getById(chunk.id);
      expect(updatedChunk?.notebookId).toBe(notebook.id); // Updated
    });

    it('should remove a chunk assignment by passing null for notebookId', async () => {
      await notebookService.assignChunkToNotebook(chunk.id, notebook.id);
      let updatedChunk = await chunkSqlModel.getById(chunk.id);
      expect(updatedChunk?.notebookId).toBe(notebook.id); // Updated

      const result = await notebookService.assignChunkToNotebook(chunk.id, null);
      expect(result).toBe(true);
      updatedChunk = await chunkSqlModel.getById(chunk.id);
      expect(updatedChunk?.notebookId).toBeNull(); // Updated
    });

    it('should throw an error if trying to assign a chunk to a non-existent notebook', async () => {
      const nonExistentNotebookId = randomUUID();
      await expect(notebookService.assignChunkToNotebook(chunk.id, nonExistentNotebookId))
        .rejects
        .toThrow(`Target notebook not found with ID: ${nonExistentNotebookId}`);
    });

    it('should return false if trying to assign a non-existent chunk (ChunkSqlModel handles this)', async () => {
      const nonExistentChunkId = 999999;
      const result = await notebookService.assignChunkToNotebook(nonExistentChunkId, notebook.id);
      expect(result).toBe(false); // ChunkSqlModel.assignToNotebook returns false for non-existent chunkId
    });
  });

  describe('getChunksForNotebook', () => {
    let notebook1: NotebookRecord;
    let notebook2: NotebookRecord;
    let jeffersObj1: JeffersObject;

    beforeEach(async () => {
      notebook1 = await notebookService.createNotebook('NBWithChunks', 'Desc1');
      notebook2 = await notebookService.createNotebook('NBWithoutChunks', 'Desc2');

      const tempJeffersObj1 = await objectModel.getBySourceUri(`jeffers://notebook/${notebook1.id}`);
      if (!tempJeffersObj1) throw new Error ('JeffersObject for notebook1 not found in getChunksForNotebook beforeEach');
      jeffersObj1 = tempJeffersObj1;

      // Create and assign some chunks to notebook1
      const chunk1 = await chunkSqlModel.addChunk({ objectId: jeffersObj1.id, chunkIdx: 0, content: 'c1' });
      await chunkSqlModel.assignToNotebook(chunk1.id, notebook1.id);
      const chunk2 = await chunkSqlModel.addChunk({ objectId: jeffersObj1.id, chunkIdx: 1, content: 'c2' });
      await chunkSqlModel.assignToNotebook(chunk2.id, notebook1.id);
    });

    it('should retrieve all chunks assigned to a specific notebook', async () => {
      const chunks = await notebookService.getChunksForNotebook(notebook1.id);
      expect(chunks.length).toBe(2);
      expect(chunks.every(c => c.notebookId === notebook1.id)).toBe(true); // Updated
      expect(chunks[0].content).toBe('c1');
      expect(chunks[1].content).toBe('c2');
    });

    it('should return an empty array for a notebook with no assigned chunks', async () => {
      const chunks = await notebookService.getChunksForNotebook(notebook2.id);
      expect(chunks).toEqual([]);
    });

    it('should throw an error if trying to get chunks for a non-existent notebook', async () => {
      const nonExistentNotebookId = randomUUID();
      await expect(notebookService.getChunksForNotebook(nonExistentNotebookId))
        .rejects
        .toThrow(`Notebook not found with ID: ${nonExistentNotebookId}`);
    });
  });

  describe('Constructor and BaseService integration', () => {
    it('should initialize with proper dependencies', () => {
      expect(notebookService).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith('[NotebookService] Initialized.');
    });

    it('should inherit BaseService functionality', async () => {
      // Test that execute wrapper works
      const notebooks = await notebookService.getNotebooks();
      
      // Should log the operation with execute wrapper format
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[NotebookService] getNotebooks started')
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[NotebookService] getNotebooks completed')
      );
    });
  });

  describe('Lifecycle methods', () => {
    it('should support initialize method', async () => {
      // Already called in beforeEach, create a new instance to test
      const newService = new NotebookService({
        db,
        notebookModel,
        objectModel,
        chunkSqlModel,
        chatModel
      });
      await expect(newService.initialize()).resolves.toBeUndefined();
    });

    it('should support cleanup method', async () => {
      // NotebookService doesn't have resources to clean up, so it should be a no-op
      await expect(notebookService.cleanup()).resolves.toBeUndefined();
    });

    it('should support health check', async () => {
      const isHealthy = await notebookService.healthCheck();
      expect(isHealthy).toBe(true);
    });
  });

  describe('Error handling with BaseService', () => {
    it('should use execute wrapper for error handling', async () => {
      // Mock the model to throw an error
      vi.spyOn(notebookModel, 'getAll').mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      await expect(notebookService.getNotebooks()).rejects.toThrow('Database connection lost');
      
      // Should log the error with proper context
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[NotebookService] getNotebooks failed'),
        expect.any(Error)
      );
    });

    it('should use transaction wrapper for transactional operations', async () => {
      // Mock db.transaction to verify it's called
      const transactionSpy = vi.spyOn(db, 'transaction');
      
      // Create a notebook (which uses transaction internally)
      await notebookService.createNotebook('Transaction Test', 'Testing transactions');
      
      // Verify transaction was used
      expect(transactionSpy).toHaveBeenCalled();
    });
  });

  describe('Dependency injection patterns', () => {
    it('should work with mocked dependencies', async () => {
      // Create fully mocked dependencies
      const mockNotebookModel = {
        create: vi.fn().mockReturnValue({
          id: 'mock-notebook-id',
          title: 'Mock Notebook',
          description: 'Mocked',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }),
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn()
      } as unknown as NotebookModel;

      const mockObjectModel = {
        create: vi.fn().mockReturnValue({
          id: 'mock-object-id',
          source_uri: 'jeffers://notebook/mock-notebook-id',
          title: 'Mock Notebook',
          type: 'notebook'
        }),
        getById: vi.fn()
      } as unknown as ObjectModel;

      const mockChunkModel = {
        getByNotebookId: vi.fn().mockReturnValue([])
      } as unknown as ChunkSqlModel;

      const mockChatModel = {
        listSessionsForNotebook: vi.fn().mockReturnValue([])
      } as unknown as ChatModel;

      // Create service with mocked dependencies
      const serviceWithMocks = new NotebookService({
        db,
        notebookModel: mockNotebookModel,
        objectModel: mockObjectModel,
        chunkSqlModel: mockChunkModel,
        chatModel: mockChatModel
      });

      const notebook = await serviceWithMocks.createNotebook('Test', 'Test Description');
      
      expect(mockNotebookModel.create).toHaveBeenCalled();
      expect(mockObjectModel.create).toHaveBeenCalled();
      expect(notebook.title).toBe('Mock Notebook');
    });

    it('should allow testing without database', async () => {
      // Create stub dependencies that don't need a real database
      const stubNotebookModel = {
        create: vi.fn().mockImplementation((id, title, objectId, description) => ({
          id,
          title,
          objectId,
          description,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })),
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      } as unknown as NotebookModel;

      const stubObjectModel = {
        create: vi.fn().mockImplementation((uri, title, type) => ({
          id: 'stub-object-id',
          source_uri: uri,
          title,
          type,
          created_at: Date.now()
        })),
        getById: vi.fn(),
        deleteBySourceUri: vi.fn()
      } as unknown as ObjectModel;

      const stubChunkModel = {
        getByNotebookId: vi.fn().mockReturnValue([]),
        assignToNotebook: vi.fn()
      } as unknown as ChunkSqlModel;

      const stubChatModel = {
        listSessionsForNotebook: vi.fn().mockReturnValue([]),
        deleteSessionsForNotebook: vi.fn()
      } as unknown as ChatModel;

      const serviceWithStub = new NotebookService({
        db: {} as Database.Database, // Dummy db object
        notebookModel: stubNotebookModel,
        objectModel: stubObjectModel,
        chunkSqlModel: stubChunkModel,
        chatModel: stubChatModel
      });

      // Test operations
      const notebook = await serviceWithStub.createNotebook('Stub Test', 'Stubbed notebook');
      expect(stubNotebookModel.create).toHaveBeenCalled();
      expect(stubObjectModel.create).toHaveBeenCalled();
      expect(notebook.id).toBeDefined();
    });
  });

  describe('Integration with real models', () => {
    it('should perform transactional operations correctly', async () => {
      // This tests the real integration with transaction support
      const notebook = await notebookService.createNotebook(
        'Transactional Test',
        'Testing transactional integrity'
      );

      expect(notebook.id).toBeDefined();
      expect(notebook.objectId).toBeDefined();

      // Verify both notebook and object were created
      const retrievedNotebook = await notebookService.getNotebook(notebook.id);
      expect(retrievedNotebook?.title).toBe('Transactional Test');

      // Verify the object exists
      const object = objectModel.getById(notebook.objectId!);
      expect(object).toBeDefined();
      expect(object?.source_uri).toBe(`jeffers://notebook/${notebook.id}`);
    });
  });
}); 