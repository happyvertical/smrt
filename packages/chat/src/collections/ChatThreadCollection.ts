import { SmrtCollection } from '@happyvertical/smrt-core';
import { ChatThread } from '../models/ChatThread.js';

export class ChatThreadCollection extends SmrtCollection<ChatThread> {
  static readonly _itemClass = ChatThread;

  async getByRoom(roomId: string): Promise<ChatThread[]> {
    return this.list({ where: { roomId } });
  }

  async getActive(roomId: string): Promise<ChatThread[]> {
    const threads = await this.list({ where: { roomId } });
    return threads.filter((t) => !t.isResolved);
  }

  async getUnresolved(): Promise<ChatThread[]> {
    const threads = await this.list({});
    return threads.filter((t) => !t.isResolved);
  }
}
