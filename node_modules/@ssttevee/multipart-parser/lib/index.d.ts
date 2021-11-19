export interface Part<TData = Uint8Array> {
    name: string;
    data: TData;
    filename?: string;
    contentType?: string;
}
export declare function streamMultipart(body: ReadableStream<Uint8Array>, boundary: string): AsyncIterableIterator<Part<AsyncIterableIterator<Uint8Array>>>;
export declare function iterateMultipart(body: ReadableStream<Uint8Array>, boundary: string): AsyncIterableIterator<Part>;
export declare function parseMultipart(body: ReadableStream<Uint8Array>, boundary: string): Promise<Part[]>;
