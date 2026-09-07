/*
 * Stack flip/reset geometry adapted from Cornerstone3D Viewport.
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
// Exact method text is retained to exercise the installed-source fingerprint.
module.exports = {
flip({ flipHorizontal, flipVertical }) {
        const imageData = this.getDefaultImageData();
        if (!imageData) {
            return;
        }
        const camera = this.getCamera();
        const { viewPlaneNormal, viewUp, focalPoint, position } = camera;
        const viewRight = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.cross */ .eR.cross(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), viewPlaneNormal, viewUp);
        let viewUpToSet = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.copy */ .eR.copy(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), viewUp);
        const viewPlaneNormalToSet = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.negate */ .eR.negate(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), viewPlaneNormal);
        const distance = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.distance */ .eR.distance(position, focalPoint);
        const dimensions = imageData.getDimensions();
        const middleIJK = dimensions.map((d) => Math.floor(d / 2));
        const idx = [middleIJK[0], middleIJK[1], middleIJK[2]];
        const centeredFocalPoint = imageData.indexToWorld(idx, gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create());
        const resetFocalPoint = this._getFocalPointForResetCamera(centeredFocalPoint, camera, { resetPan: true, resetToCenter: false });
        const panDir = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.subtract */ .eR.subtract(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), focalPoint, resetFocalPoint);
        const panValue = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.length */ .eR.length(panDir);
        const getPanDir = (mirrorVec) => {
            const panDirMirror = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.scale */ .eR.scale(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), mirrorVec, 2 * gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.dot */ .eR.dot(panDir, mirrorVec));
            gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.subtract */ .eR.subtract(panDirMirror, panDirMirror, panDir);
            gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.normalize */ .eR.normalize(panDirMirror, panDirMirror);
            return panDirMirror;
        };
        if (flipHorizontal) {
            const panDirMirror = getPanDir(viewUpToSet);
            const newFocalPoint = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.scaleAndAdd */ .eR.scaleAndAdd(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), resetFocalPoint, panDirMirror, panValue);
            const newPosition = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.scaleAndAdd */ .eR.scaleAndAdd(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), newFocalPoint, viewPlaneNormalToSet, distance);
            this.setCamera({
                viewPlaneNormal: viewPlaneNormalToSet,
                position: newPosition,
                focalPoint: newFocalPoint,
            });
            this.flipHorizontal = !this.flipHorizontal;
        }
        if (flipVertical) {
            viewUpToSet = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.negate */ .eR.negate(viewUpToSet, viewUp);
            const panDirMirror = getPanDir(viewRight);
            const newFocalPoint = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.scaleAndAdd */ .eR.scaleAndAdd(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), resetFocalPoint, panDirMirror, panValue);
            const newPosition = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.scaleAndAdd */ .eR.scaleAndAdd(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), newFocalPoint, viewPlaneNormalToSet, distance);
            this.setCamera({
                focalPoint: newFocalPoint,
                viewPlaneNormal: viewPlaneNormalToSet,
                viewUp: viewUpToSet,
                position: newPosition,
            });
            this.flipVertical = !this.flipVertical;
        }
        this.render();
    },
_getFocalPointForResetCamera(centeredFocalPoint, previousCamera, { resetPan = true, resetToCenter = true }) {
        if (resetToCenter && resetPan) {
            return centeredFocalPoint;
        }
        if (resetToCenter && !resetPan) {
            return (0,_utilities_hasNaNValues__WEBPACK_IMPORTED_MODULE_12__/* ["default"] */ .A)(previousCamera.focalPoint)
                ? centeredFocalPoint
                : previousCamera.focalPoint;
        }
        if (!resetToCenter && resetPan) {
            const oldCamera = previousCamera;
            const oldFocalPoint = oldCamera.focalPoint;
            const oldViewPlaneNormal = oldCamera.viewPlaneNormal;
            const vectorFromOldFocalPointToCenteredFocalPoint = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.subtract */ .eR.subtract(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), centeredFocalPoint, oldFocalPoint);
            const distanceFromOldFocalPointToCenteredFocalPoint = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.dot */ .eR.dot(vectorFromOldFocalPointToCenteredFocalPoint, oldViewPlaneNormal);
            const newFocalPoint = gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.scaleAndAdd */ .eR.scaleAndAdd(gl_matrix__WEBPACK_IMPORTED_MODULE_3__/* .vec3.create */ .eR.create(), centeredFocalPoint, oldViewPlaneNormal, -1 * distanceFromOldFocalPointToCenteredFocalPoint);
            return [newFocalPoint[0], newFocalPoint[1], newFocalPoint[2]];
        }
        if (!resetPan && !resetToCenter) {
            return (0,_utilities_hasNaNValues__WEBPACK_IMPORTED_MODULE_12__/* ["default"] */ .A)(previousCamera.focalPoint)
                ? centeredFocalPoint
                : previousCamera.focalPoint;
        }
    }
};
