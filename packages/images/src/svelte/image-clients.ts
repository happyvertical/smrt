import type { Image } from '../image';

export type ImageLike = Omit<
  Pick<
    Image,
    | 'id'
    | 'name'
    | 'sourceUri'
    | 'mimeType'
    | 'description'
    | 'width'
    | 'height'
    | 'alt'
  >,
  'id'
> & {
  id: string;
  url?: string;
};

export interface ImagesGalleryQuery {
  limit: number;
  offset: number;
  q?: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  minWidth?: number;
  minHeight?: number;
}

export interface ImagesGalleryResult {
  items: ImageLike[];
}

export interface ImagesGalleryClient {
  list(query: ImagesGalleryQuery): Promise<ImagesGalleryResult>;
}

export interface ImageResizeRequest {
  width: number;
  height: number;
}

export interface ImageCropRequest {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageConvertRequest {
  format: string;
}

export interface ImageEditRequest {
  prompt: string;
}

export interface ImageEditorResult {
  image: ImageLike;
}

export interface ImageEditorClient {
  resize(id: string, payload: ImageResizeRequest): Promise<ImageEditorResult>;
  crop(id: string, payload: ImageCropRequest): Promise<ImageEditorResult>;
  convert(id: string, payload: ImageConvertRequest): Promise<ImageEditorResult>;
  edit(id: string, payload: ImageEditRequest): Promise<ImageEditorResult>;
}
