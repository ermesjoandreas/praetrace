import { Base } from './base.js';
import type { Persisted } from './base.js';
import { log } from './index.js';

/** Both heritage edges at once, and a call to a member it inherits rather than declares. */
export class Disk extends Base implements Persisted {
  override flush(): void {
    log('flush');
  }

  save(): void {
    this.close();
  }
}
