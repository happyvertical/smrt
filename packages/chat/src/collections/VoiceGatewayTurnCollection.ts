import { SmrtCollection } from '@happyvertical/smrt-core';
import { VoiceGatewayTurn } from '../models/VoiceGatewayTurn.js';

export class VoiceGatewayTurnCollection extends SmrtCollection<VoiceGatewayTurn> {
  static readonly _itemClass = VoiceGatewayTurn;

  async reserveTurn(input: {
    tenantId: string;
    voiceSessionId: string;
    gatewaySessionId: string;
    gatewayTurnId: string;
    target: string;
  }): Promise<VoiceGatewayTurn> {
    return this.create({
      ...input,
      status: 'processing',
      _insertOnly: true,
    });
  }
}
