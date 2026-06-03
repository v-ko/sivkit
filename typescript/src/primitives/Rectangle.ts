import { Point2D } from "./Point2D"
import { Size } from "./Size";


export type RectangleData = [number, number, number, number];

export class Rectangle {
    private _data: RectangleData;

    constructor(data: RectangleData) {
        this._data = data;
    }
    static fromPoints(top_left: Point2D, bottom_right: Point2D): Rectangle {
        const x = Math.min(top_left.x, bottom_right.x)
        const y = Math.min(top_left.y, bottom_right.y)
        const w = Math.abs(top_left.x - bottom_right.x)
        const h = Math.abs(top_left.y - bottom_right.y)
        return new Rectangle([x, y, w, h])
    }

    get x(): number { return this._data[0]; }
    get y(): number { return this._data[1]; }
    get w(): number { return this._data[2]; }
    get h(): number { return this._data[3]; }

    data(): RectangleData {
        return this._data
    }
    copy(): Rectangle {
        return new Rectangle([...this._data]);
    }

    equals(other: Rectangle): boolean {
        for (let i = 0; i < 4; i++) {
            if (this._data[i] !== other._data[i]) {
                return false;
            }
        }
        return true;
    }

    get width(): number {
        return this._data[2];
    }
    get height(): number {
        return this._data[3];
    }

    size(): Size {
        return new Size([this._data[2], this._data[3]])
    }
    setSize(new_size: Size) {
        this._data[2] = new_size.width
        this._data[3] = new_size.height
    }
    setWidth(new_width: number) {
        this._data[2] = new_width
    }
    setHeight(new_height: number) {
        this._data[3] = new_height
    }
    setTopLeft(point: Point2D) {
        this._data[0] = point.x
        this._data[1] = point.y
    }
    setX(x: number) {
        this._data[0] = x
    }
    setY(y: number) {
        this._data[1] = y
    }
    moveCenter(point: Point2D) {
        const half_size = this.size()
        half_size.divide_inplace(2)
        this._data[0] = point.x - half_size.width
        this._data[1] = point.y - half_size.height;
    }
    top(): number {
        return this._data[1];
    }
    left(): number {
        return this._data[0];
    }
    bottom(): number {
        return this._data[1] + this._data[3];
    }
    right(): number {
        return this._data[0] + this._data[2];
    }
    topLeft(): Point2D {
        return new Point2D([this._data[0], this._data[1]])
    }
    topRight(): Point2D {
        return new Point2D([this._data[0] + this._data[2], this._data[1]])
    }
    bottomRight(): Point2D {
        return new Point2D([this._data[0] + this._data[2], this._data[1] + this._data[3]])
    }
    bottomLeft(): Point2D {
        return new Point2D([this._data[0], this._data[1] + this._data[3]])
    }

    center(): Point2D {
        return new Point2D([this._data[0] + this._data[2] / 2, this._data[1] + this._data[3] / 2]);
    }
    area(): number {
        return this._data[2] * this._data[3];
    }
    intersection(other: Rectangle): Rectangle | null {
        const x1 = Math.max(this._data[0], other._data[0]);
        const y1 = Math.max(this._data[1], other._data[1]);
        const x2 = Math.min(this.right(), other.right());
        const y2 = Math.min(this.bottom(), other.bottom());

        if (x1 >= x2 || y1 >= y2) {
            return null;
        }

        return new Rectangle([x1, y1, x2 - x1, y2 - y1]);
    }

    intersects(other: Rectangle): boolean {
        return (
            this.x < other.x + other.w &&
            this.x + this.w > other.x &&
            this.y < other.y + other.h &&
            this.y + this.h > other.y
        );
    }
    contains(point: Point2D): boolean {
        const self = this._data;
        return ((self[0] <= point.x && point.x <= self[0] + self[2]) &&
                (self[1] <= point.y && point.y <= self[1] + self[3]))
    }
}
