import requests
import numpy as np
import rasterio
from rasterio.mask import mask
from shapely.geometry import Point, mapping
from shapely.ops import transform
import pyproj

## NEO db ##

def initiate_NEO():

    url = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"

    keys = [
        "spkid", "full_name", "pdes", "name", "neo", "pha", "moid", "e", "a", "q", "i", 
        "om", "w", "ma", "tp", "per", "n", "ad", "H", "diameter", "extent", "GM", "density", 
        "rot_per", "albedo", "source", "producer", "first_obs", "last_obs", "spec_T", 
        "spec_B", "epoch", "equinox", "soln_date"
    ]

    params = {
        "fields": ",".join(keys),
        "sb-group": "pha",
        "sb-kind": "a",
    }

    resp = requests.get(url, params=params)
    resp.raise_for_status()
    recived = resp.json()
    #print(recived)
    elem = recived["data"]

    def dtype(val):
        s = str(val).strip()
        if s.isdigit():
            s = int(s)
        elif s.replace('.', '', 1).replace('-', '', 1).isdigit():
            s =  float(s)
        return s

    data = {l[0]: {k:  dtype(val) for k, val in zip(keys, l)} for l in elem}

    return data

def NEO_catalog(db, start: int, offset: int):
    """Return a slice of the NEO catalog.
            db: dict keyed by spkid
            start: starting index in the ordered key list
            offset: number of records to return
    """
    if offset <= 0:
        return []
    keys = list(db.keys())
    slice_keys = keys[start:start+offset]
    return [db[k] for k in slice_keys]

def NEO_by_id(db, obj_id):
    """Lookup asteroid by spkid directly in dict (returns None if missing)."""
    return db.get(obj_id)


#################################################################################

#This code gets coordinates (lat,lon) and from those coordinates returns
#k, constant which if you multiply by the kinetic energy of the meteor at impact
#gives you the energy of the impact which u can convert to magnitude

#get elevation using etopo1
def get_elevation(lat, lon):
    url = f"https://api.opentopodata.org/v1/etopo1?locations={lat},{lon}"
    resp = requests.get(url)
    resp.raise_for_status()  # raises error if request failed
    data = resp.json()
    elev = data["results"][0]["elevation"]  # in meters
    return elev

#get rock type 👍
#if u touch this u dead i have no clue how this works
def get_rock_type(lat, lon): #officialy, it should be called "GLiM Class" not rock type
    url = "https://services8.arcgis.com/4KhTMTZ1x0f76DSg/arcgis/rest/services/GLiM_Niveau_I/FeatureServer/1/query"
    params = {
        "f": "json",
        "geometry": f"{lon},{lat}",          
        "geometryType": "esriGeometryPoint",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "xx_Description,Litho,IDENTITY_",
        "returnGeometry": "false"
    }
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    js = r.json()
    feats = js.get("features", [])
    if not feats:
        return None
    attrs = feats[0]["attributes"]
    # main label: "xx_Description" (e.g., "Unconsolidated sediments")
    return attrs.get("xx_Description") or attrs.get("Litho")



#ottieni elevazione, eta e tipo di terreno (stringa) sapendo lat e lon
def get_terrain_characteristics(lat,lon):
    #costante di efficienza di conversione energia cinetica e suoi possibili valori
    eta=0
    eta_LOOKUP = {
        "Unconsolidated sediments": 3e-4,
        "Siliciclastic sedimentary rocks": 5e-4,
        "Mixed sedimentary rocks": 5e-4,
        "Carbonate sedimentary rocks": 7e-4,
        "Metamorphics": 1e-3,
        "Acid/Intermediate/Basic plutonic rocks": 1e-3,
        "Acid/Intermediate/Basic volcanic rocks": 1e-3,
        "Pyroclastics": 7e-4,
        "Evaporites": 5e-4,
        "Ice and Glaciers": 5e-5,
        "Water Bodies": 1e-4,   
    }

    #altitudine punto
    elevation = get_elevation(lat, lon)
    # rock type 👍
    rock_type = get_rock_type(lat,lon)
    
    if elevation < 0:
        #it's water
        eta=eta_LOOKUP.get("Water Bodies")
    elif elevation > 0:
        #it's not water (unless it's a lake but genuinely. like there's no chance. let's be real)
        eta = eta_LOOKUP.get(rock_type, 1e-3) 
    return eta, rock_type, elevation







#####################################################################################################################



# Estimate population within a radius from a point using GHS-POP raster data
# and calculate estimated deaths given a mortality rate (phi).
#dependencies: numpy rasterio shapely pyproj

def make_geodesic_circle(lat, lon, radius_km):
    # AEQD needs an ellipsoid/sphere defined → add +datum=WGS84
    wgs84 = pyproj.CRS("EPSG:4326")
    aeqd  = pyproj.CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m +no_defs"
    )
    fwd  = pyproj.Transformer.from_crs(wgs84, aeqd, always_xy=True).transform
    back = pyproj.Transformer.from_crs(aeqd,  wgs84, always_xy=True).transform
    circle = transform(fwd, Point(lon, lat)).buffer(radius_km * 1000.0)
    return transform(back, circle)  # polygon back in WGS84

#ritorna popolazione nel raggio di radius_km attorno al punto con coordinate lat e lon
def pop_within_radius_ghs(lat, lon, radius_km):
    circle_wgs84 = make_geodesic_circle(lat, lon, radius_km)
    tif_path = r"utils\GHS_POP_E2030_GLOBE_R2023A_54009_1000_V1_0.tif"       #THAT 250MB FILE
    with rasterio.open(tif_path) as src:
        # Reproject circle to the raster CRS (54009)
        to_raster = pyproj.Transformer.from_crs("EPSG:4326", src.crs, always_xy=True).transform
        circle_raster = transform(to_raster, circle_wgs84)

        # Clip + read pixels inside the circle
        out, _ = mask(src, [mapping(circle_raster)], crop=True)
        arr = out[0].astype(float)

        # Handle NoData
        if src.nodata is not None:
            arr[arr == src.nodata] = 0
        arr[arr < 0] = 0

        # Sum = people in that area
        return float(np.nansum(arr))


def is_coordinate_over_water(lat: float, lon: float) -> bool:
    """
    Determine if a coordinate is over water based on elevation.
    Returns True if the coordinate is over water (elevation < 0).
    """
    try:
        elevation = get_elevation(lat, lon)
        return elevation < 0
    except Exception as e:
        print(f"Error checking water at ({lat}, {lon}): {e}")
        # check if over ocean
        # ocean area check
        return abs(lat) < 60 and (
            (lon < -30 and lon > -180) or  # Atlantic/Pacific
            (lon > 30 and lon < 180) or    # Pacific/Indian
            (abs(lon) < 30 and abs(lat) > 30)  # Other ocean areas
        )