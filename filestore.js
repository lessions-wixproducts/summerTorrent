var sys = require('sys'),
    bitfield = require('./bitfield');
    fs = require('fs'),
    crypto = require('crypto');

/*
 * Filestore: { pieceLength, pieces, files: [{path offset length md5}...],
 *     left }
 * offset is in increasing order, so that binary search can find a given absolute offset.
 */

function parseMultipleFiles(store, info, destDir) {
    var infoFiles = info.files,
        infoName = info.name,
        files = [],
        totalLength = 0, i, len, file;
    for (i = 0, len = infoFiles.length; i < len; i += 1) {
        file = infoFiles[i];
        files.push({path: destDir + '/' + infoName + '/' + file.path,
            offset: totalLength, length: file.length, md5sum: file.md5sum});
        totalLength += file.length;
    }
    store.files = files;
    store.totalLength = totalLength;
    sys.log('files: ' + JSON.stringify(store.files));
}

function create(metaInfo, destDir) {
    var result, info, pieceLength;
    result = {pieceLength: metaInfo['piece length'], pieces: metaInfo.pieces};
    if ('info' in metaInfo) {
        info = metaInfo.info;
        if (! ('pieces' in info)) {
            throw 'missing pieces';
        }
        result.pieces = info.pieces;
        if (! ('piece length' in info)) {
            throw 'missing piece length';
        }
        pieceLength = info['piece length'];
        result.pieceLength = pieceLength;

        // Check if this is a single file torrent or a file list torrent
        if ('length' in info) {
            // single file
            result.files = [{path: destDir + '/' + info.name, offset: 0, length: info.length, md5: info.md5}];
            result.totalLength = info.length;
        } else {
            parseMultipleFiles(result, info, destDir);
        }
    } else {
        throw 'no info found in metaInfo';
    }
    result.pieceCount = Math.floor((result.totalLength + pieceLength - 1) / pieceLength);
    result.lastPieceLength = result.pieceCount <= 0 ? 0 :
        result.totalLength - pieceLength * (result.pieceCount - 1);
    return result;
}

// Find file that associates with offset
// returns index of file
function findFile(files, offset) {
    var a = -1, b = files.length, c, file;
    while (a < b) {
        c = (a + b) >> 1;
        file = files[c];
        if (file.offset <= offset && file.offset + file.length > offset) {
            return c;
        } else if (file.offset < offset) {
            a = c;
        } else {
            a = b;
        }
    }
}

// Returns an iterator object with two methods: hasNext() and next().
// Next will return {file, offset, length}
function createRangeIterator(store, offset, length) {
    var files = store.files,
        i = findFile(files, offset);
    return {
        hasNext : function () {
            return length > 0;
        },
        next: function () {
            var file, fileOffset, fileLength;
            if (length <= 0) {
                throw "StopIteraton";
            }
            file = files[i];
            fileOffset = file.offset - offset;
            fileLength = Math.min(file.length - fileOffset, length);
            i += 1;
            length -= fileLength;
            offset += fileLength;
            return {file: file, offset: fileOffset, length: fileLength};
        }
    };
}

// Calls callback(err, file)
function ensureFile(file, callback) {
    var mode = 6 * 64 + 4 * 8 + 4; // 0644 aka rw-r--r--
    if (file.fd) {
        callback(null, file);
    } else {
        fs.stat(file.path, function (err, stats) {
            if (err) {
                fs.open(file.path, 'w', mode, function (error, fd) {
                    if (error) {
                        callback(error, file);
                    } else {
                        fs.truncate(fd, file.length, function (error) {
                            if (error) {
                                callback(error, file);
                            } else {
                                // Need to close this descriptor and try again.
                                fs.close(fd, function (error) {
                                    if (error) {
                                        callback(error, file);
                                    }
                                    ensureFile(file, callback);
                                });
                            }
                        });
                    }
                });
            } else if (stats.isDirectory() || stats.size !== file.length) {
                fs.unlink(file.path, function (error) {
                    if (error) {
                        callback(error, file);
                    } else {
                        ensureFile(file, callback);
                    }
                });
            } else {
                // file exists, and is right length and type
                fs.open(file.path, 'r+', mode, function (error, fd) {
                    if (error) {
                        callback(error, file);
                    } else {
                        file.fd = fd;
                        callback(error, file);
                    }
                });
            }
        });
    }
}

function createPieceFragmentIterator(store, pieceIndex) {
    var pieceLength = store.pieceLength,
        offset = pieceLength * pieceIndex,
        length = Math.min(store.totalLength - offset, pieceLength);
    return createRangeIterator(store, offset, length);
}

// Callback called asynchronously, with args (error, data)
// data will be null after all fragments have been read.

function readPieceImp(iterator, callback) {
    var fragment;
    if (iterator.hasNext()) {
        fragment = iterator.next();
        ensureFile(fragment.file, function (error, file) {
            if (error) {
                callback(error);
            } else {
                fs.read(file.fd, fragment.length, fragment.offset, 'binary',
                    function (err, data, bytesRead) {
                        var fragment;
                        callback(err, data);
                        if (! err) {
                            readPieceImp(iterator, callback);
                        }
                    });
            }
        });
    } else {
        callback(null, null);
    }
}

function readPiece(store, pieceIndex, callback) {
    var iterator = createPieceFragmentIterator(store, pieceIndex);
    readPieceImp(iterator, callback);
}

function pieceLength(store, pieceIndex) {
    if (pieceIndex < store.pieceCount - 1) {
        return store.pieceLength;
    } else {
        return store.lastPieceLength;
    }
}

function inspectImp(store, pieceIndex, hash, callback) {
    readPiece(store, 0, function (error, data) {
        var digest, expected, goodPiece;
        if (error) {
            callback(error);
        } else {
            if (data) {
                hash.update(data);
            } else {
                digest = hash.digest('binary');
                expected = store.pieces.substring(pieceIndex * 20, (pieceIndex + 1) * 20);
                goodPiece = expected === digest;
                store.bitfield.set(pieceIndex, goodPiece);
                if (!goodPiece) {
                    store.left += pieceLength(store, pieceIndex);
                }
                pieceIndex += 1;
                if (pieceIndex < store.pieceCount) {
                    hash = crypto.createHash('sha1');
                    inspectImp(store, pieceIndex, hash, callback);
                } else {
                    callback(null);
                }
            }
        }
    });
}

// callback(err)
function inspect(store, callback) {
    var hash = crypto.createHash('sha1');
    store.bitfield = bitfield.create(store.pieceCount);
    store.left = 0;
    inspectImp(store, 0, hash, callback);
}

exports.create = create;
exports.inspect = inspect;
