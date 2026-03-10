import { readFile, writeFile } from 'node:fs/promises';
import { StaticDecode, StaticEncode, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export class FileSource<T extends TSchema> {
  private abspath: string;
  private schema: T;
  private data?: Promise<StaticDecode<T>>;

  public constructor(abspath: string, schema: T) {
    this.abspath = abspath;
    this.schema = schema;
    this.data = undefined;
  }

  private async read(): Promise<StaticDecode<T>> {
    const fileData = await readFile(this.abspath, 'utf-8');
    const parsed = JSON.parse(fileData);
    if (!Value.Check(this.schema, parsed)) {
      const strs = [`File ${this.abspath} failed schema validation:`];
      for (const err of Value.Errors(this.schema, parsed)) {
        strs.push(`=>  ${err.path}: ${err.message}`);
      }
      throw new Error(strs.join('\n') + '\n');
    }
    const decoded = Value.Decode(this.schema, parsed);
    return decoded;
  }

  public load(): Promise<StaticDecode<T>> {
    this.data ??= this.read();
    return this.data;
  }

  private async write(data: StaticEncode<T>): Promise<void> {
    const str = JSON.stringify(data, null, 2);
    await writeFile(this.abspath, str);
  }

  public async update(cb: (data: StaticDecode<T>) => StaticDecode<T>) {
    const data = await this.load();
    const newData = cb(data);
    const encoded = Value.Encode(this.schema, newData);
    await this.write(encoded);
    return newData;
  }
}
