// import { Point2D } from '../types/util';
export type PointData = [number, number];

export class Vector2D {
  _data: PointData;

  constructor(data: PointData) {
    this._data = data;
  }

  get x(): number { return this._data[0]; }
  set x(val: number) { this._data[0] = val; }
  get y(): number { return this._data[1]; }
  set y(val: number) { this._data[1] = val; }

  equals(other: Vector2D): boolean {
    return this._data[0] === other._data[0] && this._data[1] === other._data[1];
  }

  // Immutable methods
  add(other: Vector2D): this {
    return new (this.constructor as any)([this._data[0] + other._data[0], this._data[1] + other._data[1]]);
  }

  subtract(other: Vector2D): this {
    return new (this.constructor as any)([this._data[0] - other._data[0], this._data[1] - other._data[1]]);
  }

  divide(k: number): this {
    return new (this.constructor as any)([this._data[0] / k, this._data[1] / k]);
  }

  round(): this {
    return new (this.constructor as any)([Math.round(this._data[0]), Math.round(this._data[1])]);
  }

  multiply(k: number): this {
    return new (this.constructor as any)([this._data[0] * k, this._data[1] * k]);
  }

  // In-place methods
  add_inplace(other: Vector2D) {
    this._data[0] += other._data[0];
    this._data[1] += other._data[1];
  }

  copy(): this {
    return new (this.constructor as any)([this._data[0], this._data[1]]);
  }

  data(): PointData {
    return this._data;
  }

  subtract_inplace(other: Vector2D) {
    this._data[0] -= other._data[0];
    this._data[1] -= other._data[1];
  }

  divide_inplace(k: number) {
    this._data[0] /= k;
    this._data[1] /= k;
  }

  round_inplace() {
    this._data[0] = Math.round(this._data[0]);
    this._data[1] = Math.round(this._data[1]);
  }

  multiply_inplace(k: number) {
    this._data[0] *= k;
    this._data[1] *= k;
  }
}

export class Point2D extends Vector2D {
  // A constructor with the same signature as the parent is created implicitly

  static fromData(data: PointData): Point2D {
    return new Point2D(data);
  }

  toString(): string {
    return `<Point x=${this.x} y=${this.y}>`;
  }

  distanceTo(point: Point2D): number {
    const distance = Math.sqrt(
      Math.pow(this._data[0] - point._data[0], 2) + Math.pow(this._data[1] - point._data[1], 2)
    );
    return distance;
  }

  rotated(radians: number, origin: Point2D): Point2D {
    const adjustedX = this._data[0] - origin._data[0];
    const adjustedY = this._data[1] - origin._data[1];
    const cosRad = Math.cos(radians);
    const sinRad = Math.sin(radians);
    const qx = origin._data[0] + cosRad * adjustedX - sinRad * adjustedY;
    const qy = origin._data[1] + sinRad * adjustedX + cosRad * adjustedY;
    return new Point2D([qx, qy]);
  }
}
