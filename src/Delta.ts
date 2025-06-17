import * as diff from 'fast-diff';
import cloneDeep = require('lodash.clonedeep');
import isEqual = require('lodash.isequal');
import AttributeMap from './AttributeMap';
import Op from './Op';
import OpIterator from './OpIterator';

const NULL_CHARACTER = String.fromCharCode(0); // Placeholder char for embed in diff()

interface EmbedHandler<T> {
  compose(a: T, b: T, keepNull: boolean): T;
  invert(a: T, b: T): T;
  transform(a: T, b: T, priority: boolean): T;
}

/**
 * 从两个操作中提取和验证嵌入类型和相关数据。
 *
 * @param a - 第一个操作，可以是插入或保留操作，预期包含一个嵌入对象。
 * @param b - 第二个操作，必须是插入操作，预期包含一个嵌入对象。
 * @returns 一个包含嵌入类型和两个操作中对应数据的元组。
 * @throws 如果两个操作中任意一个不包含对象，或者嵌入类型不匹配，则抛出错误。
 */
const getEmbedTypeAndData = (
  a: Op['insert'] | Op['retain'], // 第一个操作，可以是插入或保留操作
  b: Op['insert'], // 第二个操作，必须是插入操作
): [string, unknown, unknown] => {
  // 返回一个包含嵌入类型和两个操作中对应数据的元组
  // 检查第一个操作是否为对象
  if (typeof a !== 'object' || a === null) {
    throw new Error(`cannot retain a ${typeof a}`); // 如果不是对象，则抛出错误
  }

  // 检查第二个操作是否为对象
  if (typeof b !== 'object' || b === null) {
    throw new Error(`cannot retain a ${typeof b}`); // 如果不是对象，则抛出错误
  }

  // 获取第一个操作的嵌入类型
  const embedType = Object.keys(a)[0];

  // 检查嵌入类型是否匹配
  if (!embedType || embedType !== Object.keys(b)[0]) {
    throw new Error(
      `embed types not matched: ${embedType} != ${Object.keys(b)[0]}`,
    ); // 如果嵌入类型不匹配，则抛出错误
  }

  // 返回嵌入类型和两个操作中对应数据的元组
  return [embedType, a[embedType], b[embedType]];
};

class Delta {
  static Op = Op;
  static OpIterator = OpIterator;
  static AttributeMap = AttributeMap;
  private static handlers: { [embedType: string]: EmbedHandler<unknown> } = {};

  static registerEmbed<T>(embedType: string, handler: EmbedHandler<T>): void {
    this.handlers[embedType] = handler;
  }

  static unregisterEmbed(embedType: string): void {
    delete this.handlers[embedType];
  }

  private static getHandler(embedType: string): EmbedHandler<unknown> {
    const handler = this.handlers[embedType];
    if (!handler) {
      throw new Error(`no handlers for embed type "${embedType}"`);
    }
    return handler;
  }

  ops: Op[];
  constructor(ops?: Op[] | { ops: Op[] }) {
    // Assume we are given a well formed ops
    if (Array.isArray(ops)) {
      this.ops = ops;
    } else if (ops != null && Array.isArray(ops.ops)) {
      this.ops = ops.ops;
    } else {
      this.ops = [];
    }
  }

  /**
   * 插入一个新的操作到 Delta 中。
   *
   * @param arg - 要插入的内容，可以是字符串或嵌入对象。
   * @param attributes - 可选的属性对象，用于描述插入的内容。
   * @returns Delta 实例本身，用于链式调用。
   */
  insert(
    arg: string | Record<string, unknown>, // 要插入的内容，可以是字符串或嵌入对象
    attributes?: AttributeMap | null, // 可选的属性对象，用于描述插入的内容
  ): this {
    // 创建一个新的操作对象
    const newOp: Op = {};

    // 如果 arg 是空字符串，则直接返回 Delta 实例本身
    if (typeof arg === 'string' && arg.length === 0) {
      return this;
    }

    // 将 arg 设置为新操作的插入内容
    newOp.insert = arg;

    // 如果 attributes 不为空，则将其设置为新操作的属性
    if (
      attributes != null &&
      typeof attributes === 'object' &&
      Object.keys(attributes).length > 0
    ) {
      newOp.attributes = attributes;
    }

    // 将新操作添加到 Delta 中
    return this.push(newOp);
  }

  delete(length: number): this {
    if (length <= 0) {
      return this;
    }
    return this.push({ delete: length });
  }

  retain(
    length: number | Record<string, unknown>,
    attributes?: AttributeMap | null,
  ): this {
    if (typeof length === 'number' && length <= 0) {
      return this;
    }
    const newOp: Op = { retain: length };
    if (
      attributes != null &&
      typeof attributes === 'object' &&
      Object.keys(attributes).length > 0
    ) {
      newOp.attributes = attributes;
    }
    return this.push(newOp);
  }

  /**
   * 将一个新的操作添加到 Delta 中。
   *
   * @param newOp - 要添加的操作对象。
   * @returns Delta 实例本身，用于链式调用。
   */
  push(newOp: Op): this {
    // 获取当前 Delta 中的操作列表长度
    let index = this.ops.length;

    // 获取当前 Delta 中的最后一个操作
    let lastOp = this.ops[index - 1];

    // 克隆新的操作对象
    newOp = cloneDeep(newOp);

    // 如果最后一个操作是对象类型
    if (typeof lastOp === 'object') {
      // 如果新的操作是删除类型，并且最后一个操作也是删除类型
      if (
        typeof newOp.delete === 'number' &&
        typeof lastOp.delete === 'number'
      ) {
        // 合并两个删除操作
        this.ops[index - 1] = { delete: lastOp.delete + newOp.delete };
        return this;
      }

      // 如果新的操作是插入类型，并且最后一个操作是删除类型
      if (typeof lastOp.delete === 'number' && newOp.insert != null) {
        // 将新的操作插入到最后一个操作之前
        index -= 1;
        lastOp = this.ops[index - 1];
        if (typeof lastOp !== 'object') {
          this.ops.unshift(newOp);
          return this;
        }
      }

      // 如果新的操作和最后一个操作的属性相同
      if (isEqual(newOp.attributes, lastOp.attributes)) {
        // 如果新的操作是插入类型，并且最后一个操作也是插入类型
        if (
          typeof newOp.insert === 'string' &&
          typeof lastOp.insert === 'string'
        ) {
          // 合并两个插入操作
          this.ops[index - 1] = { insert: lastOp.insert + newOp.insert };
          if (typeof newOp.attributes === 'object') {
            this.ops[index - 1].attributes = newOp.attributes;
          }
          return this;
        } else if (
          typeof newOp.retain === 'number' &&
          typeof lastOp.retain === 'number'
        ) {
          // 合并两个保留操作
          this.ops[index - 1] = { retain: lastOp.retain + newOp.retain };
          if (typeof newOp.attributes === 'object') {
            this.ops[index - 1].attributes = newOp.attributes;
          }
          return this;
        }
      }
    }

    // 如果新的操作不能合并到最后一个操作中，则将其添加到操作列表中
    if (index === this.ops.length) {
      this.ops.push(newOp);
    } else {
      this.ops.splice(index, 0, newOp);
    }
    return this;
  }

  /**
   * 删除 Delta 中的最后一个操作，如果该操作是保留类型且没有属性。
   *
   * @returns Delta 实例本身，用于链式调用。
   */
  chop(): this {
    // 获取当前 Delta 中的最后一个操作
    const lastOp = this.ops[this.ops.length - 1];

    // 如果最后一个操作是保留类型且没有属性，则删除它
    if (lastOp && typeof lastOp.retain === 'number' && !lastOp.attributes) {
      this.ops.pop();
    }
    return this;
  }

  filter(predicate: (op: Op, index: number) => boolean): Op[] {
    return this.ops.filter(predicate);
  }

  forEach(predicate: (op: Op, index: number) => void): void {
    this.ops.forEach(predicate);
  }

  map<T>(predicate: (op: Op, index: number) => T): T[] {
    return this.ops.map(predicate);
  }

  partition(predicate: (op: Op) => boolean): [Op[], Op[]] {
    const passed: Op[] = [];
    const failed: Op[] = [];
    this.forEach((op) => {
      const target = predicate(op) ? passed : failed;
      target.push(op);
    });
    return [passed, failed];
  }

  reduce<T>(
    predicate: (accum: T, curr: Op, index: number) => T,
    initialValue: T,
  ): T {
    return this.ops.reduce(predicate, initialValue);
  }

  changeLength(): number {
    return this.reduce((length, elem) => {
      if (elem.insert) {
        return length + Op.length(elem);
      } else if (elem.delete) {
        return length - elem.delete;
      }
      return length;
    }, 0);
  }

  length(): number {
    return this.reduce((length, elem) => {
      return length + Op.length(elem);
    }, 0);
  }

  /**
   * 截取 Delta 中的操作，从指定的开始索引到结束索引。
   *
   * @param start - 开始索引，默认为 0。
   * @param end - 结束索引，默认为 Infinity。
   * @returns 一个新的 Delta 实例，包含截取的操作。
   */
  slice(start = 0, end = Infinity): Delta {
    // 创建一个新的操作列表
    const ops = [];

    // 创建一个操作迭代器
    const iter = new OpIterator(this.ops);

    // 初始化索引
    let index = 0;

    // 遍历操作列表
    while (index < end && iter.hasNext()) {
      // 获取下一个操作
      let nextOp;
      if (index < start) {
        // 如果索引小于开始索引，则跳过该操作
        nextOp = iter.next(start - index);
      } else {
        // 如果索引大于或等于开始索引，则将该操作添加到新的操作列表中
        nextOp = iter.next(end - index);
        ops.push(nextOp);
      }
      index += Op.length(nextOp);
    }

    // 创建一个新的 Delta 实例，包含截取的操作
    return new Delta(ops);
  }

  compose(other: Delta): Delta {
    const thisIter = new OpIterator(this.ops);
    const otherIter = new OpIterator(other.ops);
    const ops = [];
    const firstOther = otherIter.peek();
    if (
      firstOther != null &&
      typeof firstOther.retain === 'number' &&
      firstOther.attributes == null
    ) {
      let firstLeft = firstOther.retain;
      while (
        thisIter.peekType() === 'insert' &&
        thisIter.peekLength() <= firstLeft
      ) {
        firstLeft -= thisIter.peekLength();
        ops.push(thisIter.next());
      }
      if (firstOther.retain - firstLeft > 0) {
        otherIter.next(firstOther.retain - firstLeft);
      }
    }
    const delta = new Delta(ops);
    while (thisIter.hasNext() || otherIter.hasNext()) {
      if (otherIter.peekType() === 'insert') {
        delta.push(otherIter.next());
      } else if (thisIter.peekType() === 'delete') {
        delta.push(thisIter.next());
      } else {
        const length = Math.min(thisIter.peekLength(), otherIter.peekLength());
        const thisOp = thisIter.next(length);
        const otherOp = otherIter.next(length);
        if (otherOp.retain) {
          const newOp: Op = {};
          if (typeof thisOp.retain === 'number') {
            newOp.retain =
              typeof otherOp.retain === 'number' ? length : otherOp.retain;
          } else {
            if (typeof otherOp.retain === 'number') {
              if (thisOp.retain == null) {
                newOp.insert = thisOp.insert;
              } else {
                newOp.retain = thisOp.retain;
              }
            } else {
              const action = thisOp.retain == null ? 'insert' : 'retain';
              const [embedType, thisData, otherData] = getEmbedTypeAndData(
                thisOp[action],
                otherOp.retain,
              );
              const handler = Delta.getHandler(embedType);
              newOp[action] = {
                [embedType]: handler.compose(
                  thisData,
                  otherData,
                  action === 'retain',
                ),
              };
            }
          }
          // Preserve null when composing with a retain, otherwise remove it for inserts
          const attributes = AttributeMap.compose(
            thisOp.attributes,
            otherOp.attributes,
            typeof thisOp.retain === 'number',
          );
          if (attributes) {
            newOp.attributes = attributes;
          }
          delta.push(newOp);

          // Optimization if rest of other is just retain
          if (
            !otherIter.hasNext() &&
            isEqual(delta.ops[delta.ops.length - 1], newOp)
          ) {
            const rest = new Delta(thisIter.rest());
            return delta.concat(rest).chop();
          }

          // Other op should be delete, we could be an insert or retain
          // Insert + delete cancels out
        } else if (
          typeof otherOp.delete === 'number' &&
          (typeof thisOp.retain === 'number' ||
            (typeof thisOp.retain === 'object' && thisOp.retain !== null))
        ) {
          delta.push(otherOp);
        }
      }
    }
    return delta.chop();
  }

  concat(other: Delta): Delta {
    const delta = new Delta(this.ops.slice());
    if (other.ops.length > 0) {
      delta.push(other.ops[0]);
      delta.ops = delta.ops.concat(other.ops.slice(1));
    }
    return delta;
  }

  diff(other: Delta, cursor?: number | diff.CursorInfo): Delta {
    if (this.ops === other.ops) {
      return new Delta();
    }
    const strings = [this, other].map((delta) => {
      return delta
        .map((op) => {
          if (op.insert != null) {
            return typeof op.insert === 'string' ? op.insert : NULL_CHARACTER;
          }
          const prep = delta === other ? 'on' : 'with';
          throw new Error('diff() called ' + prep + ' non-document');
        })
        .join('');
    });
    const retDelta = new Delta();
    const diffResult = diff(strings[0], strings[1], cursor, true);
    const thisIter = new OpIterator(this.ops);
    const otherIter = new OpIterator(other.ops);
    diffResult.forEach((component: diff.Diff) => {
      let length = component[1].length;
      while (length > 0) {
        let opLength = 0;
        switch (component[0]) {
          case diff.INSERT:
            opLength = Math.min(otherIter.peekLength(), length);
            retDelta.push(otherIter.next(opLength));
            break;
          case diff.DELETE:
            opLength = Math.min(length, thisIter.peekLength());
            thisIter.next(opLength);
            retDelta.delete(opLength);
            break;
          case diff.EQUAL:
            opLength = Math.min(
              thisIter.peekLength(),
              otherIter.peekLength(),
              length,
            );
            const thisOp = thisIter.next(opLength);
            const otherOp = otherIter.next(opLength);
            if (isEqual(thisOp.insert, otherOp.insert)) {
              retDelta.retain(
                opLength,
                AttributeMap.diff(thisOp.attributes, otherOp.attributes),
              );
            } else {
              retDelta.push(otherOp).delete(opLength);
            }
            break;
        }
        length -= opLength;
      }
    });
    return retDelta.chop();
  }

  eachLine(
    predicate: (
      line: Delta,
      attributes: AttributeMap,
      index: number,
    ) => boolean | void,
    newline = '\n',
  ): void {
    const iter = new OpIterator(this.ops);
    let line = new Delta();
    let i = 0;
    while (iter.hasNext()) {
      if (iter.peekType() !== 'insert') {
        return;
      }
      const thisOp = iter.peek();
      const start = Op.length(thisOp) - iter.peekLength();
      const index =
        typeof thisOp.insert === 'string'
          ? thisOp.insert.indexOf(newline, start) - start
          : -1;
      if (index < 0) {
        line.push(iter.next());
      } else if (index > 0) {
        line.push(iter.next(index));
      } else {
        if (predicate(line, iter.next(1).attributes || {}, i) === false) {
          return;
        }
        i += 1;
        line = new Delta();
      }
    }
    if (line.length() > 0) {
      predicate(line, {}, i);
    }
  }

  invert(base: Delta): Delta {
    const inverted = new Delta();
    this.reduce((baseIndex, op) => {
      if (op.insert) {
        inverted.delete(Op.length(op));
      } else if (typeof op.retain === 'number' && op.attributes == null) {
        inverted.retain(op.retain);
        return baseIndex + op.retain;
      } else if (op.delete || typeof op.retain === 'number') {
        const length = (op.delete || op.retain) as number;
        const slice = base.slice(baseIndex, baseIndex + length);
        slice.forEach((baseOp) => {
          if (op.delete) {
            inverted.push(baseOp);
          } else if (op.retain && op.attributes) {
            inverted.retain(
              Op.length(baseOp),
              AttributeMap.invert(op.attributes, baseOp.attributes),
            );
          }
        });
        return baseIndex + length;
      } else if (typeof op.retain === 'object' && op.retain !== null) {
        const slice = base.slice(baseIndex, baseIndex + 1);
        const baseOp = new OpIterator(slice.ops).next();
        const [embedType, opData, baseOpData] = getEmbedTypeAndData(
          op.retain,
          baseOp.insert,
        );
        const handler = Delta.getHandler(embedType);
        inverted.retain(
          { [embedType]: handler.invert(opData, baseOpData) },
          AttributeMap.invert(op.attributes, baseOp.attributes),
        );
        return baseIndex + 1;
      }
      return baseIndex;
    }, 0);
    return inverted.chop();
  }

  transform(index: number, priority?: boolean): number;
  transform(other: Delta, priority?: boolean): Delta;
  /**
   * 将一个操作转化为另一个操作，以便于实现实时协同编辑。
   *
   * @param arg - 要转化的操作，可以是数字索引或 Delta 对象。
   * @param priority - 转化的优先级，默认为 false。
   * @returns 转化后的操作，可以是数字索引或 Delta 对象。
   */
  transform(arg: number | Delta, priority = false): typeof arg {
    /** 将优先级转化为布尔值 */
    priority = !!priority;

    /** 如果 arg 是数字索引，则转化为位置 */
    if (typeof arg === 'number') {
      return this.transformPosition(arg, priority);
    }

    const other: Delta = arg;

    /** 创建两个操作迭代器 */
    const thisIter = new OpIterator(this.ops);
    const otherIter = new OpIterator(other.ops);

    /** 创建一个新的 Delta 对象 */
    const delta = new Delta();

    /** 遍历两个操作列表*/
    while (thisIter.hasNext() || otherIter.hasNext()) {
      /** 如果当前操作是插入类型，并且优先级为 true 或其他操作不是插入类型，则保留当前操作 */
      if (
        thisIter.peekType() === 'insert' &&
        (priority || otherIter.peekType() !== 'insert')
      ) {
        delta.retain(Op.length(thisIter.next()));
      } else if (otherIter.peekType() === 'insert') {
        /** 如果其他操作是插入类型，则添加到新的 Delta 对象中 */
        delta.push(otherIter.next());
      } else {
        /** 如果两个操作都是保留类型或删除类型，则合并它们 */
        const length = Math.min(thisIter.peekLength(), otherIter.peekLength());
        const thisOp = thisIter.next(length);
        const otherOp = otherIter.next(length);

        /** 如果当前操作是删除类型，则跳过 */
        if (thisOp.delete) {
          continue;
        } else if (otherOp.delete) {
          /** 如果其他操作是删除类型，则添加到新的 Delta 对象中 */
          delta.push(otherOp);
        } else {
          /** 如果两个操作都是保留类型，则合并它们 */
          const thisData = thisOp.retain;
          const otherData = otherOp.retain;

          /** 初始化转化后的数据 */
          let transformedData: Op['retain'] =
            typeof otherData === 'object' && otherData !== null
              ? otherData
              : length;

          /** 如果两个操作的数据都是对象类型，则合并它们 */
          if (
            typeof thisData === 'object' &&
            thisData !== null &&
            typeof otherData === 'object' &&
            otherData !== null
          ) {
            /**  获取嵌入类型 */
            const embedType = Object.keys(thisData)[0];

            /** 如果两个操作的嵌入类型相同，则合并它们 */
            if (embedType === Object.keys(otherData)[0]) {
              const handler = Delta.getHandler(embedType);
              if (handler) {
                transformedData = {
                  [embedType]: handler.transform(
                    thisData[embedType],
                    otherData[embedType],
                    priority,
                  ),
                };
              }
            }
          }

          /** 保留转化后的数据 */
          delta.retain(
            transformedData,
            AttributeMap.transform(
              thisOp.attributes,
              otherOp.attributes,
              priority,
            ),
          );
        }
      }
    }

    /** 删除最后一个操作 */
    return delta.chop();
  }

  /**
   * 主要作用是将一个位置（索引）转化为另一个位置，以便于实现实时协同编辑。
   * 在实时协同编辑中，当多个用户同时编辑同一个文档时，需要确保每个用户的编辑操作不会冲突。为此，需要将每个用户的编辑操作转化为一个新的位置，以便于其他用户可以正确地应用这些编辑操作。
   * 这个函数 transformPosition 就是用来实现这种转化的。它接受一个位置（索引）和一个优先级作为输入，输出一个新的位置（索引）。
   * 具体来说，这个函数会遍历操作列表，根据操作类型（插入、删除等）和优先级来调整索引的值。例如，如果遇到一个删除操作，则会减少索引的值；如果遇到一个插入操作，则会增加索引的值。
   * 通过这种方式，transformPosition 函数可以确保在实时协同编辑中，每个用户的编辑操作都可以正确地应用到文档中，而不会出现冲突。
   *
   * @param index - 要转化的位置。
   * @param priority - 转化的优先级，默认为 false。
   * @returns 转化后的位置。
   */
  transformPosition(index: number, priority = false): number {
    /** 将优先级转化为布尔值 */
    priority = !!priority;

    const thisIter = new OpIterator(this.ops);
    let offset = 0;

    while (thisIter.hasNext() && offset <= index) {
      /** 获取下一个操作的长度 */
      const length = thisIter.peekLength();

      /** 获取下一个操作的类型 */
      const nextType = thisIter.peekType();

      /** 移动到下一个操作*/
      thisIter.next();

      /** 如果下一个操作是删除类型，则减少索引 */
      if (nextType === 'delete') {
        index -= Math.min(length, index - offset);
        continue;
      } else if (nextType === 'insert' && (offset < index || !priority)) {
        /** 如果下一个操作是插入类型，并且优先级为 false 或索引小于偏移量，则增加索引 */
        index += length;
      }

      offset += length;
    }

    /** 返回转化后的索引*/
    return index;
  }
}

export default Delta;

export { Op, OpIterator, AttributeMap };

if (typeof module === 'object') {
  module.exports = Delta;
  module.exports.default = Delta;
}
