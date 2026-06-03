import { Vector2D } from "./Point2D";

export type SizeData = [number, number];

export class Size extends Vector2D {

    constructor(data: SizeData) {
        super(data);
    }

    get width(): number {
        return this.x;
    }

    get height(): number {
        return this.y;
    }

    set width(width: number) {
        this.x = width;
    }

    set height(height: number) {
        this.y = height;
    }

}
