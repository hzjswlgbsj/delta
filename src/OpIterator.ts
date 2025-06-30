import Op from './Op';

export default class Iterator {
  ops: Op[];
  index: number;
  offset: number;

  constructor(ops: Op[]) {
    this.ops = ops;
    this.index = 0;
    this.offset = 0;
  }

  hasNext(): boolean {
    return this.peekLength() < Infinity;
  }

  /**
   * 返回当前操作的一部分或完整内容，并自动推进迭代器的游标状态。
   *
   * 在 Delta 的 transform 或 compose 过程中，需要对操作（op）进行**按字符级别**的消费与对齐处理。
   * 因此不能简单地一次性处理完整 op，而需要「切片式」地逐步消费操作内容。
   *
   * 例如：
   * - 当前 op 为 `{ retain: 10 }`，调用 `next(4)` 会返回 `{ retain: 4 }`，并留下剩余 `{ retain: 6 }`。
   * - 当前 op 为 `{ insert: "hello" }`，`offset = 2`，调用 `next(2)` 会返回 `{ insert: "ll" }`。
   *
   * ### 特性说明：
   * - 支持 insert、retain、delete 三种类型；
   * - 支持部分消费（裁切），并自动更新 offset；
   * - 返回始终为合法的 Delta Op 结构；
   * - 对于不可裁切的嵌入（如 image embed），仅允许整块返回。
   *
   * @param length - 要消费的最大长度，默认 Infinity 表示完整消费当前 op。
   * @returns 标准化的 Op 片段，类型可能为 `{ insert }`、`{ retain }` 或 `{ delete }`。
   *          若所有操作已消费完，返回 `{ retain: Infinity }` 作为虚拟终止占位。
   */
  next(length?: number): Op {
    // 如果没有指定 length，默认消耗无限长（即整个 op）
    if (!length) {
      length = Infinity;
    }

    const nextOp = this.ops[this.index];

    // 如果还有操作未遍历完
    if (nextOp) {
      const offset = this.offset;
      const opLength = Op.length(nextOp);

      // 如果 length 足以消费剩下的整个 op，推进到下一个 op
      if (length >= opLength - offset) {
        length = opLength - offset;
        this.index += 1;
        this.offset = 0;
      } else {
        // 否则只推进 offset，保留当前 op 供下一轮继续消费
        this.offset += length;
      }

      // === delete 类型处理 ===
      if (typeof nextOp.delete === 'number') {
        return { delete: length };
      }

      // === retain/insert 类型处理 ===
      const retOp: Op = {};

      if (nextOp.attributes) {
        retOp.attributes = nextOp.attributes;
      }

      if (typeof nextOp.retain === 'number') {
        // retain:number，可以被部分消费
        retOp.retain = length;
      } else if (typeof nextOp.retain === 'object' && nextOp.retain !== null) {
        // retain:object 是嵌入内容（如图片），必须整体处理，不能切
        // 此时 offset 必须是 0，length == 1
        retOp.retain = nextOp.retain;
      } else if (typeof nextOp.insert === 'string') {
        // insert:string 可按字符切片处理
        retOp.insert = nextOp.insert.substr(offset, length);
      } else {
        // insert:object（嵌入内容），不能切，必须整体返回
        // 此时 offset 必须是 0，length == 1
        retOp.insert = nextOp.insert;
      }

      return retOp;
    } else {
      // 如果操作序列已经结束，默认返回一个无限 retain
      // 表示“什么都不做，但保持位置向前推进”
      return { retain: Infinity };
    }
  }

  peek(): Op {
    return this.ops[this.index];
  }

  peekLength(): number {
    if (this.ops[this.index]) {
      // Should never return 0 if our index is being managed correctly
      return Op.length(this.ops[this.index]) - this.offset;
    } else {
      return Infinity;
    }
  }

  peekType(): string {
    const op = this.ops[this.index];
    if (op) {
      if (typeof op.delete === 'number') {
        return 'delete';
      } else if (
        typeof op.retain === 'number' ||
        (typeof op.retain === 'object' && op.retain !== null)
      ) {
        return 'retain';
      } else {
        return 'insert';
      }
    }
    return 'retain';
  }

  rest(): Op[] {
    if (!this.hasNext()) {
      return [];
    } else if (this.offset === 0) {
      return this.ops.slice(this.index);
    } else {
      const offset = this.offset;
      const index = this.index;
      const next = this.next();
      const rest = this.ops.slice(this.index);
      this.offset = offset;
      this.index = index;
      return [next].concat(rest);
    }
  }
}
