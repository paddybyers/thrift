/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

var binary = require('./binary');
var util = require('util');
var noop = function() {};

var InputBufferUnderrunError = exports.InputBufferUnderrunError = function() {
};

var TTransport = exports.TTransport = function(buf, onFlush) {
	this.reset(buf, onFlush);
};

TTransport.receiver = function(callback) {
	return function(data) {
		callback(new TTransport(data));
	};
};

TTransport.prototype = {
		reset: function(buf, onFlush) {
			this.pos = 0;
			if(buf) {
				this.buf = buf;
				if(onFlush)
					this.onFlush = onFlush;
			}
		},

		read: function(len) { // this function will be used for each frames.
			var end = this.pos + len;

			if (this.buf.length < end) {
				throw new Error('read(' + len + ') failed - not enough data');
			}

			var buf = this.buf.slice(this.pos, end);
			this.pos = end;
			return buf;
		},

		readByte: function() {
			return this.buf.readInt8(this.pos++, true);
		},

		readI16: function() {
			var i16 = this.buf.readInt16BE(this.pos, true);
			this.pos += 2;
			return i16;
		},

		readI32: function() {
			var i32 = this.buf.readInt16BE(this.pos, true);
			this.pos += 4;
			return i32;
		},

		readDouble: function() {
			var d = this.buf.readDoubleBE(this.pos, true);
			this.pos += 8;
			return d;
		},

		readString: function(len) {
			var pos = this.pos, end = pos + len;
			var str = this.buf.toString('utf8', pos, end);
			this.pos = end;
			return str;
		},

		readAll: function() {
			return this.buf.slice(0, this.pos);
		},

		writeByte: function(v) {
			this.buf.writeInt8(v, this.pos++, true);
		},

		writeI16: function(v) {
			this.buf.writeInt16BE(v, this.pos, true);
			this.pos += 2;
		},

		writeI32: function(v) {
			this.buf.writeInt32BE(v, this.pos, true);
			this.pos += 4;
		},

		writeI64: function(v) {
		    v.buffer.copy(this.buf, this.pos, 0);
			this.pos += 8;
		},

		writeDouble: function(v) {
			this.buf.writeDoubleBE(v, this.pos, true);
			this.pos += 8;
		},

		write: function(buf) {
			if (typeof(buf) === 'string') {
				this.pos += this.buf.write(buf, this.pos);
			} else {
				buf.copy(this.buf, this.pos);
				this.pos += buf.length;
			}
		},

		writeWithLength: function(buf) {
			var len, bufPos = this.pos + 4;
			if (typeof(buf) === 'string') {
				len = this.buf.write(buf, bufPos);
			} else {
				buf.copy(this.buf, bufPos);
				len = buf.length;
			}
			this.buf.writeInt32BE(len, this.pos, true);
			this.pos = len + bufPos;
		},

		flush: function(flushCallback) {
			flushCallback = flushCallback || this.onFlush;
			if(flushCallback) {
				var buf = this.buf;
				buf.length = this.pos;
				flushCallback(buf);
			}
		}
};

var TFramedTransport = exports.TFramedTransport = function(buffer, callback) {
	TTransport.call(this, buffer, callback);
};
util.inherits(TFramedTransport, TTransport);

TFramedTransport.receiver = function(callback) {
	var frameLeft = 0,
	framePos = 0,
	frame = null;
	var residual = null;

	return function(data) {
		// Prepend any residual data from our previous read
		if (residual) {
			var dat = new Buffer(data.length + residual.length);
			residual.copy(dat, 0, 0);
			data.copy(dat, residual.length, 0);
			residual = null;
		}

		// framed transport
		while (data.length) {
			if (frameLeft === 0) {
				// TODO assumes we have all 4 bytes
				if (data.length < 4) {
					console.log("Expecting > 4 bytes, found only " + data.length);
					residual = data;
					break;
					//throw Error("Expecting > 4 bytes, found only " + data.length);
				}
				frameLeft = binary.readI32(data, 0);
				frame = new Buffer(frameLeft);
				framePos = 0;
				data = data.slice(4, data.length);
			}

			if (data.length >= frameLeft) {
				data.copy(frame, framePos, 0, frameLeft);
				data = data.slice(frameLeft, data.length);

				frameLeft = 0;
				callback(new TFramedTransport(frame));
			} else if (data.length) {
				data.copy(frame, framePos, 0, data.length);
				frameLeft -= data.length;
				framePos += data.length;
				data = data.slice(data.length, data.length);
			}
		}
	};
};

TFramedTransport.prototype.flush = function() {
	var that = this;
	// TODO: optimize this better, allocate one buffer instead of both:
	var framedBuffer = function(out) {
		if(that.onFlush) {
			var msg = new Buffer(out.length + 4);
			binary.writeI32(msg, out.length);
			out.copy(msg, 4, 0, out.length);
			that.onFlush(msg);
		}
	};
	TTransport.prototype.flush.call(this, framedBuffer);
};

var TBufferedTransport = exports.TBufferedTransport = function(buffer, callback) {
	this.defaultReadBufferSize = 1024;
	this.writeBufferSize = 512; // Soft Limit
	this.buf = new Buffer(this.defaultReadBufferSize);
	this.readCursor = 0;
	this.writeCursor = 0; // for input buffer
	this.outBuffers = [];
	this.outCount = 0;
	this.onFlush = callback;
};
TBufferedTransport.receiver = function(callback) {
	var reader = new TBufferedTransport();

	return function(data) {
		if (reader.writeCursor + data.length > reader.buf.length) {
			var buf = new Buffer(reader.writeCursor + data.length);
			reader.buf.copy(buf, 0, 0, reader.writeCursor);
			reader.buf = buf;
		}
		data.copy(reader.buf, reader.writeCursor, 0);
		reader.writeCursor += data.length;

		callback(reader);
	};
};

TBufferedTransport.prototype = {
		commitPosition: function(){
			var unreadedSize = this.writeCursor - this.readCursor;
			var bufSize = (unreadedSize * 2 > this.defaultReadBufferSize) ? unreadedSize * 2 : this.defaultReadBufferSize;
			var buf = new Buffer(bufSize);
			if (unreadedSize > 0) {
				this.buf.copy(buf, 0, this.readCursor, unreadedSize);
			}
			this.readCursor = 0;
			this.writeCursor = unreadedSize;
			this.buf = buf;
		},
		rollbackPosition: function(){
			this.readCursor = 0;
		},

		// TODO: Implement open/close support
		isOpen: function() {return true;},
		open: function() {},
		close: function() {},

		ensureAvailable: function(len) {
			if (this.readCursor + len > this.writeCursor) {
				throw new InputBufferUnderrunError();
			}
		},

		read: function(len) {
			this.ensureAvailable(len)
			var buf = new Buffer(len);
			this.buf.copy(buf, 0, this.readCursor, this.readCursor + len);
			this.readCursor += len;
			return buf;
		},

		readByte: function() {
			this.ensureAvailable(1)
			return this.buf[this.readCursor++];
		},

		readI16: function() {
			this.ensureAvailable(2)
			var i16 = binary.readI16(this.buf, this.readCursor);
			this.readCursor += 2;
			return i16;
		},

		readI32: function() {
			this.ensureAvailable(4)
			var i32 = binary.readI32(this.buf, this.readCursor);
			this.readCursor += 4;
			return i32;
		},

		readDouble: function() {
			this.ensureAvailable(8)
			var d = binary.readDouble(this.buf, this.readCursor);
			this.readCursor += 8;
			return d;
		},

		readString: function(len) {
			this.ensureAvailable(len)
			var str = this.buf.toString('utf8', this.readCursor, this.readCursor + len);
			this.readCursor += len;
			return str;
		},


		readAll: function() {
			if (this.readCursor >= this.writeCursor) {
				throw new InputBufferUnderrunError();
			}
			var buf = new Buffer(this.writeCursor - this.readCursor);
			this.buf.copy(buf, 0, this.readCursor, this.writeCursor - this.readCursor);
			this.readCursor = this.writeCursor;
			return buf;
		},

		write: function(buf, encoding) {
			if (typeof(buf) === "string") {
				// Defaulting to ascii encoding here since that's more like the original
				// code, but I feel like 'utf8' would be a better choice.
				buf = new Buffer(buf, encoding || 'ascii');
			}
			if (this.outCount + buf.length > this.writeBufferSize) {
				this.flush();
			}

			this.outBuffers.push(buf);
			this.outCount += buf.length;

			if (this.outCount >= this.writeBufferSize) {
				this.flush();
			}
		},

		flush: function() {
			if (this.outCount < 1) {
				return;
			}

			var msg = new Buffer(this.outCount),
			pos = 0;
			this.outBuffers.forEach(function(buf) {
				buf.copy(msg, pos, 0);
				pos += buf.length;
			});

			if (this.onFlush) {
				this.onFlush(msg);
			}

			this.outBuffers = [];
			this.outCount = 0;
		}
};
