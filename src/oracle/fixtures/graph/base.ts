/** The top of a hierarchy: an interface to realise, a class to generalise. */
export interface Persisted {
  save(): void;
}

export abstract class Base {
  abstract flush(): void;

  close(): void {
    this.flush();
  }
}
