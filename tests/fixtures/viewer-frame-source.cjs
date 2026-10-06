/*
 * Stack frame update adapted from Cornerstone3D StackViewport.
 * MIT License — Copyright (c) 2019 Open Health Imaging Foundation.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * Source: https://github.com/cornerstonejs/cornerstone3D/blob/main/LICENSE
 * Pinned source: app.bundle.6656ed549d35896854f2.js, SHA256
 * 4fc18be2b7ae02369093d0505ae3241c9d78cb7396aebef4a0e01b8534f5ff58.
 */
// Exact method text is retained to exercise the installed-source fingerprint (byte identity is the requirement here).
module.exports = {
_updateActorToDisplayImageId(image) {
        const sameImageData = this._checkVTKImageDataMatchesCornerstoneImage(image, this._imageData);
        const viewPresentation = this.getViewPresentation();
        if (sameImageData && !this.stackInvalidated) {
            this._updateVTKImageDataFromCornerstoneImage(image);
            this.resetCameraNoEvent();
            this.setViewPresentation(viewPresentation);
            this._setPropertiesFromCache();
            this.stackActorReInitialized = false;
            return;
        }
        const { origin, direction, dimensions, spacing, numberOfComponents, imagePixelModule, } = this.getImageDataMetadata(image);
        const pixelArray = image.voxelManager.getScalarData();
        this._createVTKImageData({
            origin,
            direction,
            dimensions,
            spacing,
            numberOfComponents,
            pixelArray,
        });
        this._updateVTKImageDataFromCornerstoneImage(image);
        const actor = this.createActorMapper(this._imageData);
        const oldActors = this.getActors();
        if (oldActors.length && oldActors[0].uid === this.id) {
            oldActors[0].actor = actor;
        }
        else {
            oldActors.unshift({ uid: this.id, actor });
        }
        this.setActors(oldActors);
        const { viewPlaneNormal, viewUp } = this._getCameraOrientation(direction);
        const previousCamera = this.getCamera();
        this.setCameraNoEvent({ viewUp, viewPlaneNormal });
        this.initialViewUp = viewUp;
        this.resetCameraNoEvent();
        this.setViewPresentation(viewPresentation);
        this.triggerCameraEvent(this.getCamera(), previousCamera);
        const monochrome1 = imagePixelModule.photometricInterpretation === 'MONOCHROME1';
        this.stackInvalidated = true;
        const voiRange = this._getInitialVOIRange(image);
        this.setVOI(voiRange, {
            forceRecreateLUTFunction: !!monochrome1,
        });
        this.initialInvert = !!monochrome1;
        this.setInvertColor(this.invert || this.initialInvert);
        this.stackInvalidated = false;
        this.stackActorReInitialized = true;
        if (this._publishCalibratedEvent) {
            this.triggerCalibrationEvent();
        }
    },
};
