/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

'use strict';

const fileUrl = require("file-url");
const { Asset } = require("./asset/asset");
const { TransferAsset } = require("./asset/transferasset");
const { AssetMetadata } = require("./asset/assetmetadata");
const { TransferController, TransferEvents } = require("./transfercontroller");
const { CreateTransferParts } = require("./functions/transferpartscreate");
const { JoinTransferParts } = require("./functions/transferpartsjoin");
const { CloseFiles } = require("./functions/closefiles");
const { MapConcurrent } = require("./generator/mapconcurrent");
const { Transfer } = require("./functions/transfer");
const { executePipeline, Pipeline } = require("./generator/pipeline");
const { RandomFileAccess } = require("./randomfileaccess");
const { URL } = require("url");
const EventEmitter = require("events");

/**
 * Generate AEM download transfer assets
 * 
 * @generator
 * @param {AEMDownloadOptions} options 
 * @yields {TransferAsset} Transfer asset
 */
async function* generateAEMDownloadTransferRecords(options) {
    for (const downloadFile of options.downloadFiles) {
        const sourceUrl = new URL(downloadFile.fileUrl);
        const targetUrl = fileUrl(downloadFile.filePath);

        const source = new Asset(sourceUrl, options.headers);
        const target = new Asset(targetUrl);

        const transferAsset = new TransferAsset(source, target, {
            acceptRanges: true,
            metadata: new AssetMetadata(downloadFile.filePath, undefined, downloadFile.fileSize)
        });

        yield transferAsset;
    }
}

class AEMDownload extends EventEmitter {

    /**
     * @typedef {Object} DownloadFile
     * @property {String} fileUrl AEM url of file to download
     * @property {String} filePath Path on the local disk where to download
     * @property {Number} fileSize Size of the file being downloaded
     */
    /**
     * @typedef {Object} AEMDownloadOptions
     * @property {DownloadFile[]} downloadFiles List of files that will be downloaded.
     * @property {*} headers HTTP headers that will be included in each request sent to AEM.
     * @property {Boolean} concurrent If true, multiple files in the supplied list of download files will transfer simultaneously. If false, only one file will transfer at a time, and the next file will not begin transferring until the current file finishes.
     * @property {Number} maxConcurrent Maximum number of concurrent HTTP requests that are allowed
     * @property {Number} [preferredPartSize] Preferred part size
     */
    /**
     * Download files from AEM to local disk
     * 
     * @param {AEMDownloadOptions} options AEM download options
     */
    async downloadFiles(options) {
        const preferredPartSize = options && options.preferredPartSize;
        const maxConcurrent = (options && options.concurrent && options.maxConcurrent) || 1;

        const controller = new TransferController();
        controller.on(TransferEvents.TRANSFER_START, ({ transferAsset }) => {
            this.emit("filestart", transferAsset.eventData);
        });
        controller.on(TransferEvents.TRANSFER_PROGRESS, ({ transferAsset, transferBytes }) => {
            this.emit("fileprogress", {
                ...transferAsset.eventData,
                transferred: transferBytes
            });
        });
        controller.on(TransferEvents.TRANSFER_COMPLETE, ({ transferAsset }) => {
            this.emit("fileend", transferAsset.eventData);
        });

        // Build and execute pipeline
        const randomFileAccess = new RandomFileAccess();
        try {
            const pipeline = new Pipeline(
                new CreateTransferParts({ preferredPartSize }, controller),
                new MapConcurrent(new Transfer(randomFileAccess), { maxConcurrent }),
                new JoinTransferParts(controller),
                new CloseFiles(randomFileAccess),
            );
            await executePipeline(pipeline, generateAEMDownloadTransferRecords(options));
        } finally {
            await randomFileAccess.close();
        }
    }
}

module.exports = {
    AEMDownload
};