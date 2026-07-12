import { SmrtCollection } from '@happyvertical/smrt-core';
import { PersonaMessageRoute } from '../models/PersonaMessageRoute.js';

export class PersonaMessageRouteCollection extends SmrtCollection<PersonaMessageRoute> {
  static readonly _itemClass = PersonaMessageRoute;

  async forPersona(personaId: string): Promise<PersonaMessageRoute[]> {
    return this.list({ where: { personaId, enabled: true } });
  }
}
