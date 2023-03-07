window.UTReader = function(arrayBuffer) {
	/**
	 * Globally accessible DataView object of this file
	 */
	this.dataView = new DataView(arrayBuffer);

	/**
	 * Reference to UTReader object; used to access global variables and functions
	 */
	const reader = this;

	/**
	 * UT file signatures
	 */
	const SIGNATURE_UT   = 0x9E2A83C1;
	const SIGNATURE_UMOD = 0x9FE3C5A3;
	const SIGNATURE_UZ   = [1234, 5678];

	/**
	 * File-reading helper functions
	 */
	this.offset = 0;

	this.seek = function(offset) {
		return reader.offset = offset;
	}

	const readBytes = (fn, size) => {
		const val = fn.call(reader.dataView, reader.offset, true);
		reader.offset += size;
		return val;
	}

	const Int8      = () => readBytes(reader.dataView.getInt8,      1);
	const Uint8     = () => readBytes(reader.dataView.getUint8,     1);
	const Int16     = () => readBytes(reader.dataView.getInt16,     2);
	const Uint16    = () => readBytes(reader.dataView.getUint16,    2);
	const Int32     = () => readBytes(reader.dataView.getInt32,     4);
	const Uint32    = () => readBytes(reader.dataView.getUint32,    4);
	const Float32   = () => readBytes(reader.dataView.getFloat32,   4);
	const BigInt64  = () => readBytes(reader.dataView.getBigInt64,  8);
	const BigUint64 = () => readBytes(reader.dataView.getBigUint64, 8);

	const CompactIndex = () => {
		let value = Uint8();

		// Bit 8 = if set, result will be a negative number
		const isNegative = value & 0b10000000;

		// Bit 7 = if set, value continues into next byte
		let readNextByte = value & 0b01000000;

		// Bits 1-6 = actual value
		value = value & 0b00111111;

		for (let byteNum = 2, shiftAmt = 6; readNextByte; byteNum++, shiftAmt += 7) {
			const byte = Uint8();

			// Bit 8 is now the continuation flag, so read bits 1-7 for the value.
			// If the value spans 5 bytes, then only read bits 1-5 of the final byte
			// to make up a total of 32 bits (the most a compact index can store).
			const valueBitMask = byteNum < 5 ? 0b01111111 : 0b00011111;

			// JavaScript converts to signed integers when shifting left,
			// so use zero-fill right shift to convert back to unsigned.
			value = ((byte & valueBitMask) << shiftAmt | value) >>> 0;
			readNextByte = byte & 0b10000000;
		}

		return isNegative ? -value : value;
	}

	// Return a name from the name table from a given index,
	// or more typically, by reading a compact index.
	const Name = (index) => reader.nameTable[index ?? CompactIndex()].name;

	// Return a "templated" array of a given class or byte function
	const TArray = (type, size) => {
		const array = new Array(size ?? CompactIndex());

		switch (type.name) {
			case "Int8":
			case "Uint8":
			case "Int16":
			case "Uint16":
			case "Int32":
			case "Uint32":
			case "Float32":
			case "BigInt64":
			case "BigUint64":
			case "CompactIndex":
			case "Name":
				for (let i = 0; i < array.length; i++) array[i] = type();
			break;
			default:
				for (let i = 0; i < array.length; i++) array[i] = new type();
			break;
		}

		return array;
	}

	// Gets text where the first byte specifies the size
	this.getSizedText = function(offsetAdjust) {
		const size  = Uint8();
		const bytes = reader.dataView.buffer.slice(reader.offset, reader.offset + size - 1);

		reader.offset += size;

		if (offsetAdjust !== undefined) reader.offset += offsetAdjust;

		return reader.decodeText(bytes);
	}

	/**
	 * From Anthrax (maintainer of OldUnreal UT99 patch):
	 *   There are two legal encodings for string properties: "plain ANSI" or UTF-16LE.
	 *   If the string you want to store in the property has no characters outside the [0, 0x7F] range,
	 *   it will be stored as plain ANSI. The way to tell them apart is to look at the length that is stored
	 *   at the start of the string: positive length = ANSI, negative = UTF-16LE.
	 */
	this.getStringProperty = function() {
		const strSize    = CompactIndex();
		const isUtf16    = strSize < 0;
		const charWidth  = isUtf16 ? 2 : 1;
		const byteLength = Math.abs(strSize) * charWidth;
		const bytes      = reader.dataView.buffer.slice(reader.offset, reader.offset + byteLength - charWidth);

		reader.offset += byteLength;

		if (isUtf16) {
			return reader.decodeText(bytes, "utf-16le");
		}

		return reader.decodeText(bytes);
	}

	this.decodeText = function(bytes, encoding) {
		return new TextDecoder(encoding || "windows-1252").decode(bytes);
	}

	/**
	 * Package table objects
	 */
	class UObject {
		get objectName() {
			return Name(this.object_name_index);
		}

		get packageObject() {
			return reader.getObject(this.package_index);
		}

		get packageName() {
			return this.packageObject?.objectName || null;
		}

		get isInPackage() {
			return Boolean(this.packageObject);
		}

		get uppermostPackageObject() {
			let parent = this;

			while (parent.packageObject) {
				parent = parent.packageObject;
			}

			return parent;
		}

		get uppermostPackageObjectName() {
			return this.uppermostPackageObject.objectName;
		}
	}

	class ExportTableObject extends UObject {
		#properties;
		#propertiesEndOffset;
		#objectData;

		constructor() {
			super();
			this.class_index       = CompactIndex();
			this.super_index       = CompactIndex();
			this.package_index     = Int32();
			this.object_name_index = CompactIndex();
			this.object_flags      = Uint32();
			this.serial_size       = CompactIndex();

			if (this.hasData) {
				this.serial_offset = CompactIndex();
			}
		}

		get properties() {
			if (this.#properties) {
				reader.seek(this.#propertiesEndOffset);
				return this.#properties;
			}

			const properties = this.#properties = [];

			if (!this.hasData) return properties;

			reader.seek(this.serial_offset);

			// If RF_HasStack flag is present, handle "StateFrame" block which comes before the properties
			if (this.hasFlag(reader.objectFlags.RF_HasStack)) {
				// Not actually a property but include it anyway for completeness
				properties.push(new StateFrame());
			}

			// The first byte of property block is a name table index
			let currentPropName = Name();

			while (currentPropName.toLowerCase() !== "none") {
				const prop = {};

				// Next byte contains property info (type, size, etc.)
				const infoByte = Uint8();

				prop.name = currentPropName;
				prop.type = reader.propertyTypes[infoByte & 0xF];

				// If the property type is a struct then the struct name follows
				if (prop.type === "Struct") {
					prop.subtype = Name();
				}

				/**
				 * The size value is interpreted in the following way:
				 *   0 = 1 byte
				 *   1 = 2 bytes
				 *   2 = 4 bytes
				 *   3 = 12 bytes
				 *   4 = 16 bytes
				 *   5 = a byte follows with real size
				 *   6 = a word follows with real size
				 *   7 = an integer follows with real size
				 */
				const propSizeInfo = (infoByte >> 4) & 0x7;
				let propSize;

				switch (propSizeInfo) {
					case 0: propSize = 1;  break;
					case 1: propSize = 2;  break;
					case 2: propSize = 4;  break;
					case 3: propSize = 12; break;
					case 4: propSize = 16; break;

					case 5:
						propSize = Uint8();
					break;

					case 6:
						propSize = Uint16();
					break;

					case 7:
						propSize = Uint32();
					break;

					default:
						propSize = 1;
					break;
				}

				// Property special flags
				const arrayFlag = Boolean(infoByte >> 7);

				if (prop.type !== "Boolean" && arrayFlag) {
					let prevProp, arrayIndex;

					if (properties.length > 0) {
						prevProp = properties[properties.length - 1];

						if (prevProp.name === prop.name && prevProp.subtype === undefined) {
							prevProp.subtype = "Array";
							prevProp.index   = 0;
						}

						properties[properties.length - 1] = prevProp;
					}

					if (prevProp && prevProp.index !== undefined) {
						if (prevProp.index >= 0x3FFF) {
							arrayIndex = Uint32() & 0x3FFFFFFF;
						} else if (prevProp.index >= 0x7F) {
							arrayIndex = Uint16() & 0x7FFF;
						} else {
							arrayIndex = Uint8();
						}
					} else {
						arrayIndex = Uint8();
					}

					prop.aggtype = "Array";
					prop.index   = arrayIndex;
				}

				// Assign property value
				switch (prop.type) {
					case "Byte":
						prop.value = Uint8();
					break;

					case "Integer":
						prop.value = Int32();
					break;

					case "Boolean":
						prop.value = arrayFlag;
					break;

					case "Float":
						prop.value = Float32();
					break;

					case "Object":
						prop.value = CompactIndex();
					break;

					case "Name":
						prop.value = Name();
					break;

					// Handled later
					case "Class":
					break;

					case "Struct":
						switch (prop.subtype.toLowerCase()) {
							case "color":
								prop.value = new Colour();
							break;

							case "vector":
								prop.value = new Vector();
							break;

							case "rotator":
								prop.value = new Rotator();
							break;

							case "scale":
								prop.value = new Scale();
							break;

							case "pointregion":
								prop.value = new PointRegion();
							break;

							default:
								reader.offset += propSize;
							break;
						}
					break;

					case "Str":
						prop.value = reader.getStringProperty();
					break;

					// Unknown
					case "String":
					case "Array":
					case "Vector":
					case "Rotator":
					case "Map":
					case "Fixed Array":
					default:
						reader.offset += propSize;
					break;
				}

				properties.push(prop);

				currentPropName = Name();
			}

			this.#propertiesEndOffset = reader.offset;

			return properties;
		}

		get classObject() {
			return reader.getObject(this.class_index);
		}

		get parentObject() {
			return reader.getObject(this.super_index);
		}

		get className() {
			return this.classObject?.objectName || null;
		}

		get parentObjectName() {
			return this.parentObject?.objectName || null;
		}

		get flagNames() {
			return Object.keys(reader.objectFlags).filter(name => {
				return reader.objectFlags[name] & this.object_flags;
			})
		}

		get hasData() {
			return this.serial_size > 0;
		}

		get table() {
			return "export";
		}

		getProp(name) {
			return this.properties.find(prop => prop.name.toLowerCase() === name.toLowerCase());
		}

		hasFlag(flag) {
			return Boolean(this.object_flags & flag);
		}

		readData() {
			if (this.#objectData) return this.#objectData;

			let objectClass;

			switch (this.className) {
				case "Animation"    : objectClass = UAnimation;    break;
				case "Font"         : objectClass = UFont;         break;
				case "Level"        : objectClass = ULevel;        break;
				case "LodMesh"      : objectClass = ULodMesh;      break;
				case "Mesh"         : objectClass = UMesh;         break;
				case "Model"        : objectClass = UModel;        break;
				case "Music"        : objectClass = UMusic;        break;
				case "Palette"      : objectClass = UPalette;      break;
				case "Polys"        : objectClass = UPolys;        break;
				case "SkeletalMesh" : objectClass = USkeletalMesh; break;
				case "SkelModel"    : objectClass = USkelModel;    break;
				case "Sound"        : objectClass = USound;        break;
				case "TextBuffer"   : objectClass = UTextBuffer;   break;
				case "Texture"      : objectClass = UTexture;      break;
				default: return null;
			}

			return this.#objectData = {
				properties: this.properties,
				...new objectClass(),
			}
		}
	}

	class ImportTableObject extends UObject {
		constructor() {
			super();
			this.class_package_index = CompactIndex();
			this.class_name_index    = CompactIndex();
			this.package_index       = Int32();
			this.object_name_index   = CompactIndex();
		}

		get classPackageName() {
			return Name(this.class_package_index);
		}

		get className() {
			return Name(this.class_name_index);
		}

		get table() {
			return "import";
		}
	}

	/**
	 * Structs
	 */
	class StateFrame {
		constructor() {
			this.name          = "StateFrame";
			this.node          = CompactIndex();
			this.state_node    = CompactIndex();
			this.probe_mask    = BigInt64();
			this.latent_action = Uint32();

			if (this.node !== 0) {
				this.offset = CompactIndex();
			}
		}
	}

	class Vector {
		constructor() {
			this.x = Float32();
			this.y = Float32();
			this.z = Float32();
		}
	}

	class Rotator {
		constructor() {
			this.pitch = Int32();
			this.yaw   = Int32();
			this.roll  = Int32();
		}
	}

	class Quaternion {
		constructor() {
			this.x = Float32();
			this.y = Float32();
			this.z = Float32();
			this.w = Float32();
		}
	}

	class Colour {
		constructor() {
			this.r = Uint8();
			this.g = Uint8();
			this.b = Uint8();
			this.a = Uint8();
		}
	}

	class Scale {
		constructor() {
			this.x          = Float32();
			this.y          = Float32();
			this.z          = Float32();
			this.sheer_rate = Uint32();
			this.sheer_axis = Uint8();
		}
	}

	class PointRegion {
		constructor() {
			this.zone        = CompactIndex();
			this.i_leaf      = Uint32();
			this.zone_number = Uint8();
		}
	}

	class BoundingBox {
		constructor() {
			this.min    = new Vector();
			this.max    = new Vector();
			this.valid  = Uint8() > 0;
		}
	}

	class BoundingSphere {
		constructor() {
			this.centre = new Vector();

			if (reader.header.version > 61) {
				this.radius = Float32();
			}
		}
	}

	class Plane {
		constructor() {
			this.x = Float32();
			this.y = Float32();
			this.z = Float32();
			this.w = Float32();
		}
	}

	class BspNode {
		constructor() {
			this.plane             = new Plane();
			this.zone_mask         = BigUint64();
			this.node_flags        = Uint8();
			this.i_vert_pool       = CompactIndex();
			this.i_surf            = CompactIndex();
			this.i_front           = CompactIndex();
			this.i_back            = CompactIndex();
			this.i_plane           = CompactIndex();
			this.i_collision_bound = CompactIndex();
			this.i_render_bound    = CompactIndex();
			this.i_zone            = TArray(CompactIndex, 2);
			this.vertices          = Uint8();
			this.i_leaf            = TArray(Uint32, 2);
		}
	}

	class BspSurface {
		constructor() {
			this.texture      = CompactIndex();
			this.poly_flags   = Uint32();
			this.p_base       = CompactIndex();
			this.v_normal     = CompactIndex();
			this.v_texture_u  = CompactIndex();
			this.v_texture_v  = CompactIndex();
			this.i_light_map  = CompactIndex();
			this.i_brush_poly = CompactIndex();
			this.pan_u        = Int16();
			this.pan_v        = Int16();
			this.actor        = CompactIndex();
		}
	}

	class ModelVertex {
		constructor() {
			this.vertex = CompactIndex();
			this.i_side = CompactIndex();
		}
	}

	class MeshVertex {
		constructor() {
			// Vertex X/Y/Z values are stored in a single DWORD
			const xyz = Uint32();

			let x = (xyz & 0x7FF) / 8;
			let y = ((xyz >> 11) & 0x7FF) / 8;
			let z = ((xyz >> 22) & 0x3FF) / 4;

			if (x > 128) x -= 256;
			if (y > 128) y -= 256;
			if (z > 128) z -= 256;

			// Deus Ex
			/*const xyz = Number(BigUint64());

			let x = (xyz & 0xFFFF) / 256;
			let y = ((xyz >> 16) & 0xFFFF) / 256;
			let z = ((xyz >> 32) & 0xFFFF) / 256;

			if (x > 128) x -= 256;
			if (y > 128) y -= 256;
			if (z > 128) z -= 256;*/

			this.x = x;
			this.y = y;
			this.z = z;
		}
	}

	class MeshTriangle {
		constructor() {
			this.vertex_index_1 = Uint16();
			this.vertex_index_2 = Uint16();
			this.vertex_index_3 = Uint16();
			this.vertex_1_u     = Uint8();
			this.vertex_1_v     = Uint8();
			this.vertex_2_u     = Uint8();
			this.vertex_2_v     = Uint8();
			this.vertex_3_u     = Uint8();
			this.vertex_3_v     = Uint8();
			this.flags          = Uint32();
			this.texture_index  = Uint32();
		}
	}

	class MeshAnimationSequence {
		constructor() {
			this.name          = Name();
			this.group         = Name();
			this.start_frame   = Uint32();
			this.frame_count   = Uint32();
			this.notifications = TArray(MeshAnimNotify);
			this.rate          = Float32();
		}
	}

	class MeshAnimNotify {
		constructor() {
			this.time = Uint32();
			this.function_name = Name();
		}
	}

	class MeshConnection {
		constructor() {
			this.num_vert_triangles   = Uint32();
			this.triangle_list_offset = Uint32();
		}
	}

	class LodMeshFace {
		constructor() {
			this.wedge_index_1  = Uint16();
			this.wedge_index_2  = Uint16();
			this.wedge_index_3  = Uint16();
			this.material_index = Uint16();
		}
	}

	class LodMeshWedge {
		constructor() {
			this.vertex_index = Uint16();
			this.s            = Uint8();
			this.t            = Uint8();
		}
	}

	class LodMeshMaterial {
		constructor() {
			this.flags         = Uint32();
			this.texture_index = Uint32();
		}
	}

	class SkeletalMeshExtWedge {
		constructor() {
			this.i_vertex = Uint16();
			this.flags    = Uint16();
			this.u        = Float32();
			this.v        = Float32();
		}
	}

	class SkeletalMeshSkeleton {
		constructor() {
			this.name           = Name();
			this.flags          = Uint32();
			this.orientation    = new Quaternion();
			this.position       = new Vector();
			this.length         = Float32();
			this.x_size         = Float32();
			this.y_size         = Float32();
			this.z_size         = Float32();
			this.children_count = Uint32();
			this.parent_index   = Uint32();
		}
	}

	class SkeletalMeshBoneWeightIndex {
		constructor() {
			this.weight_index = Uint16();
			this.number       = Uint16();
			this.detail_a     = Uint16();
			this.detail_b     = Uint16();
		}
	}

	class SkeletalMeshBoneWeight {
		constructor() {
			this.point_index = Uint16();
			this.bone_weight = Uint16();
		}
	}

	class SkeletalMeshWeaponAdjust {
		constructor() {
			this.origin = new Vector();
			this.x_axis = new Vector();
			this.y_axis = new Vector();
			this.z_axis = new Vector();
		}
	}

	class BoneReference {
		constructor() {
			this.name         = Name();
			this.flags        = Uint32();
			this.parent_index = Uint32();
		}
	}

	class BoneMovement {
		constructor() {
			this.root_speed_3d = new Vector();
			this.track_time       = Float32();
			this.start_bone       = Uint32();
			this.flags            = Uint32();
			this.bones            = TArray(Uint32);
			this.animation_tracks = TArray(AnimationTrack);
			this.root_track       = new AnimationTrack();
		}
	}

	class AnimationTrack {
		constructor() {
			this.flags           = Uint32();
			this.key_quaternions = TArray(Quaternion);
			this.key_positions   = TArray(Vector);
			this.key_time        = TArray(Float32);
		}
	}

	class JointState {
		constructor() {
			this.pos   = new Vector();
			this.rot   = new Rotator();
			this.scale = new Scale();
		}
	}

	class Zone {
		constructor() {
			this.zone_actor   = CompactIndex();
			this.connectivity = BigUint64();
			this.visibility   = BigUint64();

			if (reader.header.version < 63) {
				this.last_render_time = Float32();
			}
		}
	}

	class LightMap {
		constructor() {
			this.data_offset    = Uint32();
			this.pan            = new Vector();
			this.u_clamp        = CompactIndex();
			this.v_clamp        = CompactIndex();
			this.u_scale        = Float32();
			this.v_scale        = Float32();
			this.i_light_actors = Int32();
		}
	}

	class BspLeaf {
		constructor() {
			this.i_zone        = CompactIndex()
			this.i_permeating  = CompactIndex()
			this.i_volumetric  = CompactIndex()
			this.visible_zones = BigUint64();
		}
	}

	class Polygon {
		constructor() {
			this.vertex_count = Uint8();
			this.origin       = new Vector();
			this.normal       = new Vector();
			this.texture_u    = new Vector();
			this.texture_v    = new Vector();
			this.vertices     = TArray(Vector, this.vertex_count);
			this.flags        = reader.getPolyFlags(Uint32());
			this.actor        = CompactIndex();
			this.texture      = CompactIndex();
			this.item_name  = CompactIndex();
			this.link       = CompactIndex();
			this.brush_poly = CompactIndex();
			this.pan_u      = Uint16();
			this.pan_v      = Uint16();

			if (this.pan_u > 0x8000) this.pan_u |= 0xFFFF0000;
			if (this.pan_v > 0x8000) this.pan_v |= 0xFFFF0000;
		}
	}

	class MipMap {
		constructor() {
			if (reader.header.version >= 63) {
				this.width_offset = Uint32();
			}

			this.size = CompactIndex();
			this.data = new Uint8Array(reader.dataView.buffer.slice(reader.offset, reader.offset + this.size));

			reader.offset += this.size;

			this.width       = Uint32();
			this.height      = Uint32();
			this.bits_width  = Uint8();
			this.bits_height = Uint8();
		}
	}

	class FontTexture {
		constructor() {
			this.texture    = reader.getObject(CompactIndex());
			this.characters = TArray(FontCharacter);
		}
	}

	class FontCharacter {
		constructor() {
			this.x      = Uint32();
			this.y      = Uint32();
			this.width  = Uint32();
			this.height = Uint32();
		}
	}

	/**
	 * UT native classes
	 */
	class ULevelBase {
		constructor() {
			this.actors = new Array(Uint32());

			// Seems to be repeated...
			reader.offset += 4;

			for (let i = 0; i < this.actors.length; i++) {
				this.actors[i] = reader.getObject(CompactIndex());
			}

			this.url = new LevelURL();
		}
	}

	class ULevel extends ULevelBase {
		constructor() {
			super();

			const NUM_LEVEL_TEXT_BLOCKS = 16;

			this.model         = reader.getObject(CompactIndex());
			this.reach_specs   = TArray(ReachSpec);
			this.approx_time   = Float32();
			this.first_deleted = CompactIndex();
			this.text_blocks   = new Array(NUM_LEVEL_TEXT_BLOCKS);

			for (let i = 0; i < this.text_blocks.length; i++) {
				this.text_blocks[i] = reader.getObject(CompactIndex());
			}

			if (reader.header.version > 62) {
				this.travel_info = TArray(LevelMap);
			}
		}
	}

	class LevelURL {
		constructor() {
			this.protocol = reader.getSizedText();
			this.host     = reader.getSizedText();
			this.map      = reader.getSizedText();
			this.options  = new Array(CompactIndex());

			for (let i = 0; i < this.options.length; i++) {
				this.options[i] = reader.getSizedText();
			}

			this.portal = reader.getSizedText();
			this.port   = Uint32();
			this.valid  = Uint32() > 0;
		}
	}

	class ReachSpec {
		constructor() {
			this.distance         = Uint32();
			this.start            = CompactIndex();
			this.end              = CompactIndex();
			this.collision_radius = Uint32();
			this.collision_height = Uint32();
			this.reach_flags      = Uint32();
			this.pruned           = Uint8() > 0;
		}
	}

	class LevelMap {
		constructor() {
			this.key   = reader.getSizedText();
			this.value = reader.getSizedText();
		}
	}

	class UTexture {
		constructor() {
			this.mip_maps = TArray(MipMap, Uint8());
		}
	}

	class UPalette {
		constructor() {
			this.colours = TArray(Colour);
		}
	}

	class UPolys {
		constructor() {
			this.poly_count = Uint32();

			// Seems to be repeated... (check source code)
			reader.offset += 4;

			this.polys = TArray(Polygon, this.poly_count);
		}
	}

	class UPrimitive {
		constructor() {
			this.bounding_box    = new BoundingBox();
			this.bounding_sphere = new BoundingSphere();
		}
	}

	class UModel extends UPrimitive {
		constructor() {
			super();

			if (reader.header.version <= 61) {
				this.vectors  = CompactIndex();
				this.points   = CompactIndex();
				this.nodes    = CompactIndex();
				this.surfaces = CompactIndex();
				this.vertices = CompactIndex();
			} else {
				this.vectors          = TArray(Vector);
				this.points           = TArray(Vector);
				this.nodes            = TArray(BspNode);
				this.surfaces         = TArray(BspSurface);
				this.vertices         = TArray(ModelVertex);
				this.num_shared_sides = Int32();
				this.num_zones        = Int32();
				this.zones            = TArray(Zone, this.num_zones);
			}

			this.polys      = CompactIndex();
			this.light_map  = TArray(LightMap);
			this.light_bits = TArray(Uint8);
			this.bounds     = TArray(BoundingBox);
			this.leaf_hulls = TArray(Int32);
			this.leaves     = TArray(BspLeaf);
			this.lights     = TArray(CompactIndex);

			if (reader.header.version <= 61) {
				this.leaf_zone = CompactIndex();
				this.leaf_leaf = CompactIndex();
			}

			this.root_outside = Uint32() > 0;
			this.linked       = Uint32() > 0;
		}
	}

	class UMesh extends UPrimitive {
		constructor() {
			super();

			if (reader.header.version > 61) {
				this.vertices_jump = Uint32();
			}

			this.vertices = TArray(MeshVertex);

			if (reader.header.version > 61) {
				this.triangles_jump = Uint32();
			}

			this.triangles         = TArray(MeshTriangle);
			this.anim_sequences    = TArray(MeshAnimationSequence);
			this.connects_jump     = Uint32();
			this.connections       = TArray(MeshConnection);
			this.bounding_box_2    = new BoundingBox();
			this.bounding_sphere_2 = new BoundingSphere();
			this.vert_links_jump   = Uint32();
			this.vert_links        = TArray(Uint32);

			this.textures = new Array(CompactIndex());

			for (let i = 0; i < this.textures.length; i++) {
				this.textures[i] = reader.getObject(CompactIndex());
			}

			this.bounding_boxes   = TArray(BoundingBox);
			this.bounding_spheres = TArray(BoundingSphere);
			this.frame_verts      = Uint32();
			this.anim_frames      = Uint32();
			this.flags_AND        = Uint32();
			this.flags_OR         = Uint32();
			this.scale            = new Vector();
			this.origin           = new Vector();
			this.rotation_origin  = new Rotator();
			this.cur_poly         = Uint32();
			this.cur_vertex       = Uint32();

			if (reader.header.version === 65) {
				this.texture_lod = TArray(Float32, 1);
			}

			else if (reader.header.version >= 66) {
				this.texture_lod = TArray(Float32);
			}
		}
	}

	class ULodMesh extends UMesh {
		constructor() {
			super();

			this.collapse_point_thus = TArray(Uint16);
			this.face_level          = TArray(Uint16);
			this.faces               = TArray(LodMeshFace);
			this.collapse_wedge_thus = TArray(Uint16);
			this.wedges              = TArray(LodMeshWedge);
			this.materials           = TArray(LodMeshMaterial);
			this.special_faces       = TArray(LodMeshFace);
			this.model_vertices   = Uint32();
			this.special_vertices = Uint32();
			this.mesh_scale_max   = Float32();
			this.lod_hysteresis   = Float32();
			this.lod_strength     = Float32();
			this.lod_min_verts       = Uint32();
			this.lod_morph           = Float32();
			this.lod_z_displace      = Float32();
			this.remap_anim_vertices = TArray(Uint16);
			this.old_frame_verts     = Uint32();
		}
	}

	class USkeletalMesh extends ULodMesh {
		constructor() {
			super();

			this.ext_wedges          = TArray(SkeletalMeshExtWedge);
			this.points              = TArray(Vector);
			this.skeletons           = TArray(SkeletalMeshSkeleton);
			this.bone_weight_indices = TArray(SkeletalMeshBoneWeightIndex);
			this.bone_weights        = TArray(SkeletalMeshBoneWeight);
			this.local_points        = TArray(Vector);
			this.skeletal_depth      = Uint32();
			this.default_animation   = reader.getObject(CompactIndex());
			this.weapon_bone_index   = Uint32();
			this.weapon_adjust       = new SkeletalMeshWeaponAdjust();
		}
	}

	class USkelModel extends UPrimitive {
		constructor() {
			super();

			this.num_meshes     = Int32();
			this.num_joints     = Int32();
			this.num_frames     = Int32();
			this.num_sequences  = Int32();
			this.num_skins      = Int32();
			this.root_joint     = Int32();
			this.meshes         = TArray(RMesh);
			this.joints         = TArray(RJoint);
			this.anim_sequences = TArray(RSkelAnimSeq);
			this.frames         = TArray(RAnimFrame);
			this.pos_offset     = new Vector();
			this.rot_offset     = new Rotator();
		}
	}

	class RMesh {
		constructor() {
			const NUM_POLYGROUPS = 16;

			this.num_verts = Int32();
			this.num_tris  = Int32();
			this.triangles             = TArray(RTriangle);
			this.vertices              = TArray(RVertex);
			this.dec_count             = Int32();
			this.dec                   = TArray(Int8);
			this.group_flags           = new Array(NUM_POLYGROUPS);
			this.poly_group_skin_names = new Array(NUM_POLYGROUPS);

			for (let i = 0; i < NUM_POLYGROUPS; i++) {
				this.group_flags[i] = Int32();
				this.poly_group_skin_names[i] = Name();
			}
		}
	}

	class RTriangle {
		constructor() {
			this.vertex_index_1 = Int16();
			this.vertex_index_2 = Int16();
			this.vertex_index_3 = Int16();
			this.vertex_1_u     = Int8();
			this.vertex_1_v     = Int8();
			this.vertex_2_u     = Int8();
			this.vertex_2_v     = Int8();
			this.vertex_3_u     = Int8();
			this.vertex_3_v     = Int8();
			this.polygroup      = Int8();
		}
	}

	class RVertex {
		constructor() {
			this.point1  = new Vector();
			this.point2  = new Vector();
			this.joint1  = Int32();
			this.joint2  = Int32();
			this.weight1 = Float32();
		}
	}

	class RJoint {
		constructor() {
			const MAX_CHILD_JOINTS = 4;

			this.parent     = Int32();
			this.children   = TArray(Int32, MAX_CHILD_JOINTS);
			this.name       = Name();
			this.jointgroup = Int32();
			this.flags      = Int32();
			this.baserot = new Rotator();
			this.planes = TArray(Plane, 6);
		}
	}

	class RSkelAnimSeq extends MeshAnimationSequence {
		constructor() {
			super();

			this.anim_data = TArray(Int8);
		}
	}

	class RAnimFrame {
		constructor() {
			this.sequence_id = Int16();
			this.event = Name();
			this.bounds = new BoundingBox();
			this.joint_anim = TArray(JointState);
		}
	}

	class UAnimation {
		constructor() {
			this.bones = TArray(BoneReference);
			this.movements = TArray(BoneMovement);
			this.animation_sequences = TArray(MeshAnimationSequence);
		}
	}

	class UMusic {
		constructor() {
			// If the package itself only contains music (.umx) then the first name table entry is the format.
			// This is not always the case if the music is embedded in a map, for example.
			this.format          = Name();
			this.data_end_offset = Uint32();
			this.size            = CompactIndex(); // includes null padding?
			this.audio_data      = reader.dataView.buffer.slice(reader.offset, reader.offset + this.size);
		}
	}

	class USound {
		constructor() {
			this.format = Name();

			if (reader.header.version >= 63) {
				this.next_object_offset = Uint32();
			}

			this.size         = CompactIndex();
			this.audio_offset = reader.offset;
		}
	}

	class UTextBuffer {
		constructor() {
			this.pos  = Uint32();
			this.top  = Uint32();
			this.size = CompactIndex();

			if (this.size > 0) {
				this.contents = reader.decodeText(reader.dataView.buffer.slice(reader.offset, reader.offset + this.size - 1));
				reader.offset += this.size + 1;
			}
		}
	}

	class UFont {
		constructor() {
			this.textures = TArray(FontTexture, Uint8());
		}
	}

	this.propertyTypes = [
		"Unknown",
		"Byte",
		"Integer",
		"Boolean",
		"Float",
		"Object",
		"Name",
		"String",
		"Class",
		"Array",
		"Struct",
		"Vector",
		"Rotator",
		"Str",
		"Map",
		"Fixed Array",
	];

	this.objectFlags = {
		RF_Transactional   : 0x00000001,
		RF_Unreachable     : 0x00000002,
		RF_Public          : 0x00000004,
		RF_TagImp          : 0x00000008,
		RF_TagExp          : 0x00000010,
		RF_SourceModified  : 0x00000020,
		RF_TagGarbage      : 0x00000040,
		RF_NeedLoad        : 0x00000200,
		RF_HighlightedName : 0x00000400,
		RF_InSingularFunc  : 0x00000800,
		RF_Suppress        : 0x00001000,
		RF_InEndState      : 0x00002000,
		RF_Transient       : 0x00004000,
		RF_PreLoading      : 0x00008000,
		RF_LoadForClient   : 0x00010000,
		RF_LoadForServer   : 0x00020000,
		RF_LoadForEdit     : 0x00040000,
		RF_Standalone      : 0x00080000,
		RF_NotForClient    : 0x00100000,
		RF_NotForServer    : 0x00200000,
		RF_NotForEdit      : 0x00400000,
		RF_Destroyed       : 0x00800000,
		RF_NeedPostLoad    : 0x01000000,
		RF_HasStack        : 0x02000000,
		RF_Native          : 0x04000000,
		RF_Marked          : 0x08000000,
		RF_ErrorShutdown   : 0x10000000,
		RF_DebugPostLoad   : 0x20000000,
		RF_DebugSerialize  : 0x40000000,
		RF_DebugDestroy    : 0x80000000,
	}

	this.fileTypes = {
		u    : "System",
		uax  : "Sound",
		umod : "UMOD",
		umx  : "Music",
		unr  : "Map",
		utx  : "Texture",
		uxx  : "Cache",
		uz   : "Zip",
		tmp  : "Zip",
	}

	this.defaultPackages = {
		// System
		"botpack"          : "u",
		"core"             : "u",
		"de"               : "u",
		"editor"           : "u",
		"engine"           : "u",
		"epiccustommodels" : "u",
		"fire"             : "u",
		"ipdrv"            : "u",
		"ipserver"         : "u",
		"multimesh"        : "u",
		"relics"           : "u",
		"relicsbindings"   : "u",
		"ubrowser"         : "u",
		"umenu"            : "u",
		"unreali"          : "u",
		"unrealshare"      : "u",
		"utbrowser"        : "u",
		"utmenu"           : "u",
		"utserveradmin"    : "u",
		"uweb"             : "u",
		"uwindow"          : "u",

		// Sounds
		"activates"    : "uax",
		"addon1"       : "uax",
		"ambancient"   : "uax",
		"ambcity"      : "uax",
		"ambmodern"    : "uax",
		"amboutside"   : "uax",
		"announcer"    : "uax",
		"bossvoice"    : "uax",
		"dday"         : "uax",
		"dmatch"       : "uax",
		"doorsanc"     : "uax",
		"doorsmod"     : "uax",
		"extro"        : "uax",
		"female1voice" : "uax",
		"female2voice" : "uax",
		"femalesounds" : "uax",
		"laddersounds" : "uax",
		"male1voice"   : "uax",
		"male2voice"   : "uax",
		"malesounds"   : "uax",
		"noxxsnd"      : "uax",
		"openingwave"  : "uax",
		"pan1"         : "uax",
		"rain"         : "uax",
		"tutvoiceas"   : "uax",
		"tutvoicectf"  : "uax",
		"tutvoicedm"   : "uax",
		"tutvoicedom"  : "uax",
		"vrikers"      : "uax",

		// Music
		"botmca9"  : "umx",
		"botpck10" : "umx",
		"cannon"   : "umx",
		"colossus" : "umx",
		"course"   : "umx",
		"credits"  : "umx",
		"ending"   : "umx",
		"enigma"   : "umx",
		"firebr"   : "umx",
		"foregone" : "umx",
		"godown"   : "umx",
		"lock"     : "umx",
		"mech8"    : "umx",
		"mission"  : "umx",
		"nether"   : "umx",
		"organic"  : "umx",
		"phantom"  : "umx",
		"razor-ub" : "umx",
		"run"      : "umx",
		"saveme"   : "umx",
		"savemeg"  : "umx",
		"seeker"   : "umx",
		"seeker2"  : "umx",
		"skyward"  : "umx",
		"strider"  : "umx",
		"suprfist" : "umx",
		"unworld2" : "umx",
		"utmenu23" : "umx",
		"uttitle"  : "umx",
		"wheels"   : "umx",

		// Maps
		"as-frigate"       : "unr",
		"as-guardia"       : "unr",
		"as-hispeed"       : "unr",
		"as-mazon"         : "unr",
		"as-oceanfloor"    : "unr",
		"as-overlord"      : "unr",
		"as-rook"          : "unr",
		"as-tutorial"      : "unr",
		"cityintro"        : "unr",
		"ctf-command"      : "unr",
		"ctf-coret"        : "unr",
		"ctf-cybrosis]["   : "unr",
		"ctf-darji16"      : "unr",
		"ctf-dreary"       : "unr",
		"ctf-eternalcave"  : "unr",
		"ctf-face"         : "unr",
		"ctf-face]["       : "unr",
		"ctf-gauntlet"     : "unr",
		"ctf-hallofgiants" : "unr",
		"ctf-high"         : "unr",
		"ctf-hydro16"      : "unr",
		"ctf-kosov"        : "unr",
		"ctf-lavagiant"    : "unr",
		"ctf-niven"        : "unr",
		"ctf-november"     : "unr",
		"ctf-noxion16"     : "unr",
		"ctf-nucleus"      : "unr",
		"ctf-orbital"      : "unr",
		"ctf-tutorial"     : "unr",
		"dm-agony"         : "unr",
		"dm-arcanetemple"  : "unr",
		"dm-barricade"     : "unr",
		"dm-codex"         : "unr",
		"dm-conveyor"      : "unr",
		"dm-crane"         : "unr",
		"dm-curse]["       : "unr",
		"dm-cybrosis]["    : "unr",
		"dm-deck16]["      : "unr",
		"dm-fetid"         : "unr",
		"dm-fractal"       : "unr",
		"dm-gothic"        : "unr",
		"dm-grinder"       : "unr",
		"dm-healpod]["     : "unr",
		"dm-hyperblast"    : "unr",
		"dm-kgalleon"      : "unr",
		"dm-liandri"       : "unr",
		"dm-malevolence"   : "unr",
		"dm-mojo]["        : "unr",
		"dm-morbias]["     : "unr",
		"dm-morpheus"      : "unr",
		"dm-oblivion"      : "unr",
		"dm-peak"          : "unr",
		"dm-phobos"        : "unr",
		"dm-pressure"      : "unr",
		"dm-shrapnel]["    : "unr",
		"dm-spacenoxx"     : "unr",
		"dm-stalwart"      : "unr",
		"dm-stalwartxl"    : "unr",
		"dm-tempest"       : "unr",
		"dm-turbine"       : "unr",
		"dm-tutorial"      : "unr",
		"dm-zeto"          : "unr",
		"dom-cinder"       : "unr",
		"dom-condemned"    : "unr",
		"dom-cryptic"      : "unr",
		"dom-gearbolt"     : "unr",
		"dom-ghardhen"     : "unr",
		"dom-lament"       : "unr",
		"dom-leadworks"    : "unr",
		"dom-metaldream"   : "unr",
		"dom-olden"        : "unr",
		"dom-sesmar"       : "unr",
		"dom-tutorial"     : "unr",
		"entry"            : "unr",
		"eol_assault"      : "unr",
		"eol_challenge"    : "unr",
		"eol_ctf"          : "unr",
		"eol_deathmatch"   : "unr",
		"eol_domination"   : "unr",
		"eol_statues"      : "unr",
		"utcredits"        : "unr",

		// Textures
		"alfafx"         : "utx",
		"ancient"        : "utx",
		"arenatex"       : "utx",
		"belt_fx"        : "utx",
		"blufffx"        : "utx",
		"bossskins"      : "utx",
		"castle1"        : "utx",
		"chizraefx"      : "utx",
		"city"           : "utx",
		"commandoskins"  : "utx",
		"coret_fx"       : "utx",
		"creative"       : "utx",
		"credits"        : "utx",
		"crypt"          : "utx",
		"crypt2"         : "utx",
		"crypt_fx"       : "utx",
		"ctf"            : "utx",
		"dacomafem"      : "utx",
		"dacomaskins"    : "utx",
		"ddayfx"         : "utx",
		"decayeds"       : "utx",
		"detail"         : "utx",
		"dmeffects"      : "utx",
		"egypt"          : "utx",
		"egyptpan"       : "utx",
		"eol"            : "utx",
		"faces"          : "utx",
		"fcommandoskins" : "utx",
		"female1skins"   : "utx",
		"female2skins"   : "utx",
		"fireeng"        : "utx",
		"flarefx"        : "utx",
		"fractalfx"      : "utx",
		"genearth"       : "utx",
		"genfluid"       : "utx",
		"genfx"          : "utx",
		"genin"          : "utx",
		"genterra"       : "utx",
		"genwarp"        : "utx",
		"gothfem"        : "utx",
		"gothskins"      : "utx",
		"greatfire"      : "utx",
		"greatfire2"     : "utx",
		"hubeffects"     : "utx",
		"indus1"         : "utx",
		"indus2"         : "utx",
		"indus3"         : "utx",
		"indus4"         : "utx",
		"indus5"         : "utx",
		"indus6"         : "utx",
		"indus7"         : "utx",
		"isvfx"          : "utx",
		"jwsky"          : "utx",
		"ladderfonts"    : "utx",
		"ladrarrow"      : "utx",
		"ladrstatic"     : "utx",
		"lavafx"         : "utx",
		"lian-x"         : "utx",
		"liquids"        : "utx",
		"male1skins"     : "utx",
		"male2skins"     : "utx",
		"male3skins"     : "utx",
		"menugr"         : "utx",
		"metalmys"       : "utx",
		"mine"           : "utx",
		"nalicast"       : "utx",
		"nalifx"         : "utx",
		"nivenfx"        : "utx",
		"noxxpack"       : "utx",
		"of1"            : "utx",
		"old_fx"         : "utx",
		"palettes"       : "utx",
		"phraelfx"       : "utx",
		"playrshp"       : "utx",
		"queen"          : "utx",
		"rainfx"         : "utx",
		"render"         : "utx",
		"rotatingu"      : "utx",
		"scripted"       : "utx",
		"sgirlskins"     : "utx",
		"shanechurch"    : "utx",
		"shaneday"       : "utx",
		"shanesky"       : "utx",
		"skaarj"         : "utx",
		"sktrooperskins" : "utx",
		"skybox"         : "utx",
		"skycity"        : "utx",
		"slums"          : "utx",
		"soldierskins"   : "utx",
		"spacefx"        : "utx",
		"starship"       : "utx",
		"tcowmeshskins"  : "utx",
		"tcrystal"       : "utx",
		"terranius"      : "utx",
		"tnalimeshskins" : "utx",
		"trenchesfx"     : "utx",
		"tskmskins"      : "utx",
		"ut"             : "utx",
		"ut_artfx"       : "utx",
		"utbase1"        : "utx",
		"utcrypt"        : "utx",
		"uttech1"        : "utx",
		"uttech2"        : "utx",
		"uttech3"        : "utx",
		"uwindowfonts"   : "utx",
		"xbpfx"          : "utx",
		"xfx"            : "utx",
		"xtortion"       : "utx",
		"xutfx"          : "utx",
	}

	this.polyFlags = {
		"Invisible"        : 0x00000001,
		"Masked"           : 0x00000002,
		"Translucent"      : 0x00000004,
		"NotSolid"         : 0x00000008,
		"Environment"      : 0x00000010,
		"ForceViewZone"    : 0x00000010,
		"Semisolid"        : 0x00000020,
		"Modulated"        : 0x00000040,
		"FakeBackdrop"     : 0x00000080,
		"TwoSided"         : 0x00000100,
		"AutoUPan"         : 0x00000200,
		"AutoVPan"         : 0x00000400,
		"NoSmooth"         : 0x00000800,
		"BigWavy"          : 0x00001000,
		"SpecialPoly"      : 0x00001000,
		"SmallWavy"        : 0x00002000,
		"Flat"             : 0x00004000,
		"LowShadowDetail"  : 0x00008000,
		"NoMerge"          : 0x00010000,
		"CloudWavy"        : 0x00020000,
		"DirtyShadows"     : 0x00040000,
		"BrightCorners"    : 0x00080000,
		"SpecialLit"       : 0x00100000,
		"Gouraud"          : 0x00200000,
		"NoBoundRejection" : 0x00200000,
		"Unlit"            : 0x00400000,
		"HighShadowDetail" : 0x00800000,
		"Portal"           : 0x04000000,
		"Mirrored"         : 0x08000000,
	}

	this.brushClasses = [
		"AssertMover",
		"AttachMover",
		"Brush",
		"ElevatorMover",
		"GradualMover",
		"LoopMover",
		"MixMover",
		"Mover",
		"RotatingMover",
	];

	this.moverClasses = [
		"AssertMover",
		"AttachMover",
		"ElevatorMover",
		"GradualMover",
		"LoopMover",
		"MixMover",
		"Mover",
		"RotatingMover",
	];

	this.meshClasses = [
		"Mesh",
		"LodMesh",
		"SkeletalMesh",
		"SkelModel",
	];

	this.enumBumpType = [
		"BT_PlayerBump",
		"BT_PawnBump",
		"BT_AnyBump",
	];

	this.enumMoverEncroachType = [
		"ME_StopWhenEncroach",
		"ME_ReturnWhenEncroach",
		"ME_CrushWhenEncroach",
		"ME_IgnoreWhenEncroach",
	];

	this.enumMoverGlideType = [
		"MV_MoveByTime",
		"MV_GlideByTime",
	];

	this.enumCsgOper = [
		"CSG_Active",
		"CSG_Add",
		"CSG_Subtract",
		"CSG_Intersect",
		"CSG_Deintersect",
	];

	this.enumSheerAxis = [
		"SHEER_None",
		"SHEER_XY",
		"SHEER_XZ",
		"SHEER_YX",
		"SHEER_YZ",
		"SHEER_ZX",
		"SHEER_ZY",
	];

	/**
	 * UT package functions
	 */
	this.readPackage = function() {
		// Set global variables for access within other functions
		reader.header      = reader.getPackageHeader();
		reader.version     = reader.header.version;
		reader.nameTable   = reader.getNameTable();
		reader.exportTable = reader.getExportTable();
		reader.importTable = reader.getImportTable();

		return reader;
	}

	this.getPackageHeader = function() {
		const header = {};

		reader.seek(0);

		header.signature = Uint32();

		if (header.signature !== SIGNATURE_UT) {
			throw `Invalid package signature: 0x${header.signature.toString(16).padStart(8, 0)}`;
		}

		header.version          = Uint16();
		header.licensee_version = Uint16();
		header.package_flags    = Uint32();
		header.name_count       = Uint32();
		header.name_offset      = Uint32();
		header.export_count     = Uint32();
		header.export_offset    = Uint32();
		header.import_count     = Uint32();
		header.import_offset    = Uint32();

		if (header.version < 68) {
			header.heritage_count  = Uint32();
			header.heritage_offset = Uint32();
		} else {
			header.guid = (
				  Uint32().toString(16).padStart(8, 0)
				+ Uint32().toString(16).padStart(8, 0)
				+ Uint32().toString(16).padStart(8, 0)
				+ Uint32().toString(16).padStart(8, 0)
			).toUpperCase();

			header.generation_count = Uint32();
			header.generations = [];

			for (let i = 0; i < header.generation_count; i++) {
				const generation = {};

				generation.export_count = Uint32();
				generation.name_count   = Uint32();

				header.generations.push(generation);
			}
		}

		return header;
	}

	this.getNameTable = function() {
		const nameTable = [];

		reader.seek(reader.header.name_offset);

		if (reader.header.version < 64) {
			for (let i = 0; i < reader.header.name_count; i++) {
				const bytes = [];
				let char    = Uint8();

				while (char !== 0x00) {
					bytes.push(char);
					char = Uint8();
				}

				const name  = reader.decodeText(new Uint8Array(bytes));
				const flags = Uint32();

				nameTable.push({
					name  : name,
					flags : flags,
				})
			}
		} else {
			for (let i = 0; i < reader.header.name_count; i++) {
				const name  = reader.getSizedText();
				const flags = Uint32();

				nameTable.push({
					name  : name,
					flags : flags,
				})
			}
		}

		return nameTable;
	}

	this.getExportTable = function() {
		const exportTable = new Array(reader.header.export_count);

		reader.seek(reader.header.export_offset);

		for (let i = 0; i < exportTable.length; i++) {
			exportTable[i] = new ExportTableObject();
		}

		return exportTable;
	}

	this.getImportTable = function() {
		const importTable = new Array(reader.header.import_count);

		reader.seek(reader.header.import_offset);

		for (let i = 0; i < importTable.length; i++) {
			importTable[i] = new ImportTableObject();
		}

		return importTable;
	}

	this.getObject = function(index) {
		if (index === 0) {
			return null;
		} else if (index < 0) {
			return reader.importTable[~index];
		} else {
			return reader.exportTable[index - 1];
		}
	}

	this.getExportObjectByName = function(objectName) {
		return reader.exportTable.find(item => item.objectName === objectName) || null;
	}

	this.getImportObjectByName = function(objectName) {
		return reader.importTable.find(item => item.objectName === objectName) || null;
	}

	this.getExportObjectsByName = function(objectName) {
		return reader.exportTable.filter(item => item.objectName === objectName);
	}

	this.getImportObjectsByName = function(objectName) {
		return reader.importTable.filter(item => item.objectName === objectName);
	}

	this.getObjectNameFromIndex = function(index) {
		return reader.getObject(index)?.objectName || "None";
	}

	this.getObjectsByClass = function(objectClass) {
		return reader.exportTable.filter(item => item.className === objectClass);
	}

	this.getLevelObjects = function() {
		return reader.getObjectsByClass("Level");
	}

	this.getMusicObjects = function() {
		return reader.getObjectsByClass("Music");
	}

	this.getSoundObjects = function() {
		return reader.getObjectsByClass("Sound");
	}

	this.getTextBufferObjects = function() {
		return reader.getObjectsByClass("TextBuffer");
	}

	this.getTextureObjects = function() {
		return reader.getObjectsByClass("Texture");
	}

	this.getAllBrushObjects = function() {
		return reader.exportTable.filter(item => reader.brushClasses.includes(item.className));
	}

	this.getAllMeshObjects = function() {
		return reader.exportTable.filter(item => reader.meshClasses.includes(item.className));
	}

	this.getBrushModelPolys = function(brushObject) {
		const data = {
			brush: brushObject,
			model: {},
			polys: {},
		}

		// A brush object's "Brush" property is an object reference to a Model
		const brushProp = brushObject.getProp("brush");

		if (brushProp) {
			const modelObject = reader.getObject(brushProp.value);
			const modelData   = modelObject.readData();

			data.model.object = modelObject;
			data.model.properties = modelData;

			// Polys
			if (modelData.polys !== 0) {
				const polyObject = reader.getObject(modelData.polys);
				const polysData  = polyObject.readData();

				data.polys.object   = polyObject;
				data.polys.polygons = polysData.polys;
			}
		}

		return data;
	}

	this.getAllBrushData = function() {
		return reader.getAllBrushObjects().map(reader.getBrushModelPolys);
	}

	this.getTextureInfo = function(textureObject) {
		return {
			name: textureObject.objectName,
			group: textureObject.packageName,
		}
	}

	this.getTextureGroups = function() {
		const grouped   = {};
		const ungrouped = [];

		let total = 0;

		for (const texture of reader.getTextureObjects()) {
			const textureInfo = reader.getTextureInfo(texture);

			if (textureInfo.group) {
				if (grouped[textureInfo.group] === undefined) {
					grouped[textureInfo.group] = [];
				}
				grouped[textureInfo.group].push(textureInfo.name);
			} else {
				ungrouped.push(textureInfo.name);
			}

			total++;
		}

		return {
			grouped   : grouped,
			ungrouped : ungrouped,
			length    : total,
		}
	}

	this.getSounds = function() {
		const sounds       = [];
		const soundObjects = reader.getSoundObjects();

		// Used to check for additional metadata
		const WAVE_FORMAT_PCM   = 0x01;
		const SUBCHUNK_SIZE_PCM = 0x10;

		for (const soundObject of soundObjects) {
			const sound = soundObject.readData();

			sound.name = soundObject.objectName;

			if (soundObject.isInPackage) {
				sound.package = soundObject.packageName;
			}

			// Not all sound files are PCM - e.g. ultra trash map CTF-BT-SuckmeToo seems to contain some kind of compressed audio.
			// Additionally, some files contain extra metadata so the values below cannot be accurately read unless using a more
			// sophisticated WAVE audio reading method.
			if (
				   sound.format.toUpperCase() === "WAV"
				&& reader.dataView.getUint16(sound.audio_offset + 16, true) === SUBCHUNK_SIZE_PCM
				&& reader.dataView.getUint16(sound.audio_offset + 20, true) === WAVE_FORMAT_PCM
			) {
				sound.channels    = reader.dataView.getUint16(sound.audio_offset + 22, true);
				sound.sample_rate = reader.dataView.getUint32(sound.audio_offset + 24, true);
				sound.byte_rate   = reader.dataView.getUint32(sound.audio_offset + 28, true);
				sound.bit_depth   = reader.dataView.getUint16(sound.audio_offset + 34, true);
			}

			sounds.push(sound);
		}

		return sounds;
	}

	this.getLightHsl = function(lightObject) {
		// Default UT values: 0, 255, 64
		const hsl = {
			h : 0,
			s : 100,
			l : 25
		}

		for (const prop of lightObject.properties) {
			switch (prop.name.toLowerCase()) {
				// Degree in colour wheel
				case "lighthue":
					hsl.h = Math.round(prop.value / 256 * 360);
				break;

				// UT saturation is opposite of HSL, i.e. 0% = full colour
				case "lightsaturation":
					hsl.s = 100 - Math.round(prop.value / 256 * 100);
				break;

				case "volumebrightness":
					hsl.l = Math.round(prop.value / 256 * 100);
				break;

				default:
				break;
			}
		}

		return hsl;
	}

	this.getPolyFlags = function(flags) {
		const polyFlags = [];

		for (const flagName in reader.polyFlags) {
			const flagVal = reader.polyFlags[flagName];

			if (flagVal > flags) break;

			if ((flags & flagVal) !== 0) {
				polyFlags.push(flagName);
			}
		}

		return polyFlags;
	}

	this.getPaletteCanvas = function(textureObject, callback) {
		const paletteProp = textureObject.getProp("palette");
		const paletteObject = reader.getObject(paletteProp.value);
		const paletteData = paletteObject.readData();

		const canvas  = document.createElement("canvas");
		const context = canvas.getContext("2d");

		canvas.width  = 16;
		canvas.height = 16;

		const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

		createImageBitmap(imageData).then(function(imageBitmap) {
			let i = 0;

			for (const pixel of paletteData.colours) {
				imageData.data[i++] = pixel.r;
				imageData.data[i++] = pixel.g;
				imageData.data[i++] = pixel.b;
				imageData.data[i++] = 0xFF;
			}

			context.putImageData(imageData, 0, 0);

			callback(canvas, paletteData);
		})

		return paletteData;
	}

	this.textureToCanvas = function(textureObject) {
		const textureData = textureObject.readData();
		const [mipMap, ...rest] = textureData.mip_maps;

		// TODO: handle other texture formats
		const format = textureObject.getProp("format")?.value;

		const paletteProp = textureObject.getProp("palette");
		const paletteObject = reader.getObject(paletteProp.value);
		const paletteData = paletteObject.readData();

		const canvas  = document.createElement("canvas");
		const context = canvas.getContext("2d");

		canvas.width  = mipMap.width;
		canvas.height = mipMap.height;

		const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

		let i = 0;

		for (const pixel of mipMap.data) {
			const colour = paletteData.colours[pixel];

			imageData.data[i++] = colour.r;
			imageData.data[i++] = colour.g;
				imageData.data[i++] = colour.b;
				// imageData.data[i++] = colour.a;

				// Newer versions use alpha channel, but this doesn't seem to be
				// consistent in older packages, e.g. Faces.utx has alpha set to 0
				imageData.data[i++] = 0xFF;
			}

		context.putImageData(imageData, 0, 0);

		return canvas;
	}

	this.getScreenshot = function() {
		// Multiple screenshots can be embedded to create a montage effect by
		// consecutively naming MyLevel textures "Screenshot1", "Screenshot2", etc.
		const screenshots = [];
		const screenshotRegEx = new RegExp("^Screenshot([0-9]+)?$", "i");
		const screenshotObjects = reader.getTextureObjects().filter(item => screenshotRegEx.test(item.objectName));

		if (screenshotObjects.length > 0) {
			const tempScreenshots = screenshotObjects.map(item => ({
				canvas: reader.textureToCanvas(item),
				num: Number(item.objectName.substring("Screenshot".length)),
			}));

			// Sort numerically as name table doesn't guarantee order
			tempScreenshots.sort(({ num: a }, { num: b }) => a - b);

			screenshots.push(...tempScreenshots.map(item => item.canvas));
		} else {
			// Officially, the map screenshot should be a texture named "Screenshot",
			// but sometimes it's set to a different texture (e.g. CTF-BT-Slaughter).
			// It won't appear in-game, but is still saved in the LevelSummary actor.
			const levelInfo = reader.getExportObjectByName("LevelInfo0");

			if (levelInfo) {
				const screenshotProp = levelInfo.getProp("Screenshot");

				if (screenshotProp) {
					const invalidScreenshot = reader.getObject(screenshotProp.value);

					// Final check - can't show screenshot if it's linked to an external package (e.g. CTF-BT-Brazilian-novice).
					if (invalidScreenshot.table !== "import") {
						const canvas = reader.textureToCanvas(invalidScreenshot);
						screenshots.push(canvas);
					}
				}
			}
		}

		return screenshots;
	}

	this.getLevelSummary = function(allProperties = false) {
		const levelSummary = {};
		const levelInfo = reader.getExportObjectByName("LevelInfo0");
		const meaningfulProperties = ["Author", "IdealPlayerCount", "LevelEnterText", "Song", "Title"];
		const valueIsObjIndex = ["Song", "DefaultGameType", "Summary", "NavigationPointList", "Level"];

		levelInfo?.properties.forEach(prop => {
			if (allProperties || meaningfulProperties.includes(prop.name)) {
				const propVal = valueIsObjIndex.includes(prop.name)
					? reader.getObject(prop.value).uppermostPackageObjectName
					: prop.value;

				levelSummary[prop.name] = propVal;
			}
		})

		return levelSummary;
	}

	this.getDependencies = function() {
		const dependencies = [];

		// Check dependencies against the file's "Song" name (if it's a map).
		const { Song: levelMusic } = reader.getLevelSummary();

		for (const tableEntry of reader.importTable) {
			if (tableEntry.className === "Package" && !tableEntry.isInPackage) {
				const dependency = {
					name: tableEntry.objectName,
				}

				const fileExt = reader.defaultPackages[dependency.name.toLowerCase()];
				const isDefault = fileExt !== undefined;
				const isLevelMusic = dependency.name === levelMusic;

				if (isDefault) {
					dependency.ext = fileExt;
				} else if (isLevelMusic) {
					dependency.ext = "umx";
				}

				if (isDefault || isLevelMusic) {
					dependency.type = reader.fileTypes[dependency.ext];
				}

				dependency.default = isDefault;

				dependencies.push(dependency);
			}
		}

		return dependencies;
	}

	this.getDependenciesFiltered = function(ignoreCore = true) {
		const dependencies = reader.getDependencies();
		const ignore       = ["botpack", "core", "engine", "unreali", "unrealshare", "uwindow"];
		const filtered     = {
			length   : 0,
			packages : {
				default : [],
				custom  : [],
			}
		}

		for (const dep of dependencies) {
			if (dep.default) {
				if (ignoreCore && ignore.includes(dep.name.toLowerCase())) continue;
				filtered.packages.default.push(dep);
			} else {
				filtered.packages.custom.push(dep);
			}

			filtered.length++;
		}

		return filtered;
	}

	this.getClassesCount = function() {
		const counts = {};

		for (const tableEntry of reader.exportTable) {
			if (!tableEntry.className) continue;

			const className = tableEntry.className.toLowerCase();

			if (counts[className] === undefined) {
				counts[className] = 0;
			}

			counts[className]++;
		}

		return counts;
	}
}
